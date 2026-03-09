// Simple password-based auth worker for Decap CMS
// Secrets: ADMIN_USERNAME, ADMIN_PASSWORD, GITHUB_TOKEN

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.GITHUB_TOKEN) {
      return new Response(
        "CMS not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD, and GITHUB_TOKEN secrets.",
        { status: 500 },
      );
    }

    // Handle CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Auth endpoint - show login form (GET) or validate credentials (POST)
    if (url.pathname === "/auth") {
      if (request.method === "POST") {
        const formData = await request.formData();
        const username = formData.get("username");
        const password = formData.get("password");

        if (
          username === env.ADMIN_USERNAME &&
          password === env.ADMIN_PASSWORD
        ) {
          return new Response(tokenPage(env.GITHUB_TOKEN), {
            headers: { "Content-Type": "text/html" },
          });
        } else {
          return new Response(
            loginPage("Invalid credentials. Please try again."),
            {
              headers: { "Content-Type": "text/html" },
            },
          );
        }
      }

      // GET - show login form
      return new Response(loginPage(), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Callback - redirect to auth
    if (url.pathname === "/callback") {
      return Response.redirect(url.origin + "/auth", 302);
    }

    return new Response("Not Found", { status: 404 });
  },
};

function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>Login | New Level Church CMS</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Montserrat:wght@700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
      padding: 40px;
      width: 100%;
      max-width: 400px;
    }
    .logo {
      font-family: 'Montserrat', sans-serif;
      font-size: 26px;
      font-weight: 800;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }
    .logo .red { color: #dd0e18; }
    .logo .teal { color: #3ebbc0; }
    .subtitle {
      text-align: center;
      color: #6b7280;
      font-size: 14px;
      margin-bottom: 32px;
    }
    label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      color: #1f2937;
      margin-bottom: 6px;
    }
    input {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 15px;
      font-family: 'Inter', sans-serif;
      margin-bottom: 16px;
      transition: border-color 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #dd0e18;
      box-shadow: 0 0 0 3px rgba(221, 14, 24, 0.15);
    }
    button {
      width: 100%;
      padding: 12px;
      background: #dd0e18;
      color: white;
      border: none;
      border-radius: 9999px;
      font-size: 15px;
      font-weight: 600;
      font-family: 'Inter', sans-serif;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #b80c14; }
    .error {
      background: #fef2f2;
      color: #b91c1c;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 16px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><span class="red">New Level</span> <span class="teal">Church</span></div>
    <div class="subtitle">Content Manager</div>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="POST" action="/auth">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autocomplete="username">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
}

function tokenPage(token) {
  const escapedToken = JSON.stringify(token);
  return `<!DOCTYPE html>
<html>
<head>
  <title>Authenticating...</title>
  <script>
    (function() {
      var token = ${escapedToken};
      var provider = "github";
      var data = { token: token, provider: provider };
      var successMessage = "authorization:" + provider + ":success:" + JSON.stringify(data);

      window.addEventListener("message", function(e) {
        if (e.data === "authorizing:github" || e.data.indexOf("authorizing:") === 0) {
          sendToken(e.origin);
        }
      }, false);

      function sendToken(origin) {
        var targetOrigin = origin || "*";
        if (window.opener) {
          window.opener.postMessage(successMessage, targetOrigin);
        }
        setTimeout(function() { window.close(); }, 250);
      }

      if (window.opener) {
        window.opener.postMessage("authorizing:github", "*");
      }

      setTimeout(function() {
        if (window.opener) {
          window.opener.postMessage(successMessage, "*");
        }
      }, 100);

      setTimeout(function() {
        window.close();
      }, 500);
    })();
  </script>
</head>
<body>
  <p>Authenticating... Please wait.</p>
</body>
</html>`;
}
