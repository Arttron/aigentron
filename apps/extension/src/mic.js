// Asks for the microphone once, in a normal tab (the side panel cannot show the browser's question), then closes.
document.getElementById('go').onclick = async () => {
  const msg = document.getElementById('msg');
  try {
    (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
    msg.textContent = 'Done — you can dictate now. This tab closes.';
    setTimeout(() => window.close(), 1200);
  } catch (e) {
    msg.textContent = `The microphone was not allowed (${e.name}). Allow it in the address bar's site settings for this extension and try again.`;
  }
};
