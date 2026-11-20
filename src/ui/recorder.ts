/** Запись анимации с холста в видеофайл (MediaRecorder): WebM в Chrome/Firefox/Edge, MP4 в Safari. */
import { download, stamp, toast } from './dom';

export class VideoRecorder {
  private rec: MediaRecorder | null = null;

  constructor(private getCanvas: () => HTMLCanvasElement | null) {}

  /** Вызывается при каждом начале и окончании записи — чтобы кнопка показывала верное состояние. */
  onChange: (() => void) | null = null;

  /** MediaRecorder.state становится 'inactive' сразу при stop(), не дожидаясь onstop. */
  get active(): boolean {
    return this.rec !== null && this.rec.state !== 'inactive';
  }

  start(): void {
    if (this.active) return;
    const canvas = this.getCanvas();
    if (!canvas || typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
      toast('Этот браузер не умеет записывать видео с холста');
      return;
    }
    const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const stream = canvas.captureStream(30);
    // Куски и сам рекордер держим в замыкании: новая запись, начатая до onstop предыдущей, их не перепутает.
    const chunks: Blob[] = [];
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
    } catch (e) {
      console.error(e);
      toast('Не удалось начать запись видео');
      return;
    }
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      const type = rec.mimeType || mime || 'video/webm';
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      download(`запись_${stamp()}.${ext}`, new Blob(chunks, { type }));
      if (this.rec === rec) this.rec = null;
      toast('Видео сохранено');
      this.onChange?.();
    };
    this.rec = rec;
    rec.start(500);
    toast('Идёт запись видео… Нажмите «Остановить запись», когда закончите.');
    this.onChange?.();
  }

  stop(): void {
    if (!this.active) return;
    this.rec!.stop();
    this.onChange?.();
  }
}
