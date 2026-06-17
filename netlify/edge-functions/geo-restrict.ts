import type { Context } from "@netlify/edge-functions";

const ALLOWED_COUNTRY = "BE";

const RESTRICTED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Access restricted</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Inter, system-ui, sans-serif;
      background: #f8fafc;
      color: #1e293b;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      max-width: 420px;
      width: 100%;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 32px 28px;
      box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
      text-align: center;
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 12px; }
    p { font-size: 0.9375rem; line-height: 1.55; color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Access restricted</h1>
    <p>This demo is available from Belgium only. If you believe you should have access, try again from a Belgian network or contact the site owner.</p>
  </div>
</body>
</html>`;

export default async function geoRestrict(_request: Request, context: Context) {
  const country = context.geo?.country?.code;
  if (country && country !== ALLOWED_COUNTRY) {
    return new Response(RESTRICTED_HTML, {
      status: 403,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
  return context.next();
}
