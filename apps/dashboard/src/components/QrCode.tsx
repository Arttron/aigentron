import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** The QR picture of an `otpauth://` link, drawn here (the secret never leaves the page). */
export function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return <div style={{ width: 200, maxWidth: '100%', background: '#fff', padding: 4, borderRadius: 8 }} aria-label="QR code" dangerouslySetInnerHTML={{ __html: svg }} />;
}
