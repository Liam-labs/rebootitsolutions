// Netlify Function to handle contact form submissions
// Verifies Turnstile, then emails the enquiry through the Resend REST API.

const FALLBACK_ERROR =
  'We could not send your message. Please email info@rebootitsolutions.co.uk or call us.';

const EMAIL_RE = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Collapse CR/LF (header injection) and surrounding whitespace to single spaces
function singleLine(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

function buildEmail(formData) {
  const rows = [
    ['Name', formData.name],
    ['Email', formData.email],
    ['Phone', formData.phone],
    ['Message', formData.message],
    ['Referral', formData.referral],
    ['Received', formData.submittedAt]
  ];

  const text = rows.map(([label, value]) => `${label}: ${value}`).join('\n');

  const html =
    '<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">' +
    rows
      .map(
        ([label, value]) =>
          `<tr><td style="vertical-align:top;font-weight:bold">${escapeHtml(label)}</td>` +
          `<td style="white-space:pre-wrap">${escapeHtml(value)}</td></tr>`
      )
      .join('') +
    '</table>';

  return { text, html };
}

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  const respond = (statusCode, payload) => ({
    statusCode,
    headers,
    body: JSON.stringify(payload)
  });

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return respond(405, { success: false, error: 'Method not allowed' });
  }

  try {
    // Parse form data (URL encoded)
    const params = new URLSearchParams(event.body || '');

    // Honeypot: bots fill it in. Pretend it worked, send nothing.
    if (params.get('bot-field')) {
      return respond(200, { success: true, message: 'Form submitted successfully' });
    }

    const formData = {
      name: singleLine(params.get('name') || ''),
      email: singleLine(params.get('email') || ''),
      phone: (params.get('phone') || '').trim(),
      message: (params.get('message') || '').trim(),
      referral: params.get('referral') || 'Not specified',
      turnstileToken: params.get('cf-turnstile-response'),
      submittedAt: new Date().toISOString()
    };

    // Validate required fields
    if (!formData.name || !formData.email || !formData.phone || !formData.message) {
      return respond(400, { success: false, error: 'Missing required fields' });
    }

    if (!EMAIL_RE.test(formData.email)) {
      return respond(400, { success: false, error: 'Please enter a valid email address.' });
    }

    // Verify Turnstile token (required whenever a secret is configured)
    const secretKey = process.env.TURNSTILE_SECRET_KEY;
    if (secretKey) {
      if (!formData.turnstileToken) {
        return respond(400, { success: false, error: 'Bot verification failed. Please try again.' });
      }

      const verifyResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: secretKey,
          response: formData.turnstileToken
        })
      });

      const verifyResult = await verifyResponse.json();
      if (!verifyResult.success) {
        console.log('Turnstile verification failed:', verifyResult['error-codes']);
        return respond(400, { success: false, error: 'Bot verification failed. Please try again.' });
      }
    }

    // Send the enquiry by email
    const { text, html } = buildEmail(formData);
    const logEnquiry = () => {
      console.log('Enquiry not delivered:', JSON.stringify({
        name: formData.name,
        email: formData.email,
        phone: formData.phone,
        message: formData.message,
        referral: formData.referral,
        submittedAt: formData.submittedAt
      }));
    };

    const apiKey = process.env.RESEND_API_KEY;
    const fromAddress = process.env.CONTACT_FROM_EMAIL;
    if (!apiKey || !fromAddress) {
      console.error('Contact form not configured: RESEND_API_KEY and CONTACT_FROM_EMAIL must be set');
      logEnquiry();
      return respond(502, { success: false, error: FALLBACK_ERROR });
    }

    try {
      const sendResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: `Reboot IT Website <${fromAddress}>`,
          to: [process.env.CONTACT_TO_EMAIL || 'info@rebootitsolutions.co.uk'],
          reply_to: formData.email,
          subject: `New website enquiry from ${formData.name}`,
          text,
          html
        })
      });

      if (!sendResponse.ok) {
        let detail = '';
        try { detail = await sendResponse.text(); } catch (_) { /* ignore */ }
        console.error('Resend email failed. Status:', sendResponse.status, detail);
        logEnquiry();
        return respond(502, { success: false, error: FALLBACK_ERROR });
      }
    } catch (sendError) {
      console.error('Resend email request error:', sendError && sendError.message);
      logEnquiry();
      return respond(502, { success: false, error: FALLBACK_ERROR });
    }

    return respond(200, { success: true, message: 'Form submitted successfully' });

  } catch (error) {
    console.error('Form submission error:', error);
    return respond(500, { success: false, error: 'Server error. Please try again.' });
  }
};
