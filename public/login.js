const $ = (id) => document.getElementById(id);

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('btn').disabled = true;
  $('err').textContent = '';
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: $('email').value, password: $('password').value }),
    });
    if (res.ok) {
      location.href = '/';
      return;
    }
    const data = await res.json().catch(() => ({}));
    $('err').textContent = data.error || 'Sign-in failed.';
  } catch {
    $('err').textContent = 'Network error.';
  } finally {
    $('btn').disabled = false;
  }
});
