// Share sheet / download for backups, and file picking for restore.
export async function shareOrDownload(name, text) {
  const file = new File([text], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Stylelink Orders backup' }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; /* otherwise fall back to download */ }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.className = 'hidden';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

export function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.className = 'hidden'; // no "accept" filter: phones often hide .json files when one is set
    document.body.append(input);
    const done = (v) => { input.remove(); resolve(v); };
    input.addEventListener('change', async () => { const f = input.files && input.files[0]; done(f ? await f.text() : null); });
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
}
