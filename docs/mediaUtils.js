/**
 * Media Utilities — Artemis Live Audio/Video
 * Захоплення аудіо з мікрофона, конвертація в PCM 16kHz
 * Адаптовано з офіційного прикладу Google
 */

class AudioStreamer {
  constructor(geminiClient) {
    this.client = geminiClient;
    this.mediaStream = null;
    this.audioContext = null;
    this.source = null;
    this.processor = null;
    this.isStreaming = false;
    this.deviceId = null;
    this.sharedContext = null; // спільний AudioContext від AudioPlayer
  }

  setSharedContext(ctx) {
    this.sharedContext = ctx;
  }

  async start(deviceId = null) {
    if (this.isStreaming) {
      console.warn('⚠️ Аудіо стрімінг вже запущено');
      return;
    }

    try {
      // Запитуємо будь-який доступний sample rate — ресемплимо на клієнті
      const constraints = {
        audio: deviceId
          ? { deviceId: { exact: deviceId }, channelCount: 1, echoCancellation: true, noiseSuppression: true }
          : { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      };

      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Використовуємо спільний AudioContext якщо є
      if (this.sharedContext && this.sharedContext.state !== 'closed') {
        this.audioContext = this.sharedContext;
      } else {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      const sourceRate = this.audioContext.sampleRate;
      const targetRate = 16000;

      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (event) => {
        if (!this.isStreaming || !this.client?.connected) return;

        let inputData = event.inputBuffer.getChannelData(0);

        // Ресемплінг якщо частота не 16000
        if (sourceRate !== targetRate) {
          inputData = this.resampleAudio(inputData, sourceRate, targetRate);
        }

        // Конвертуємо float32 в 16-bit PCM
        const pcm16 = this.float32ToPCM16(inputData);
        const base64 = this.arrayBufferToBase64(pcm16);

        this.client.sendAudioChunk(base64);
      };

      this.source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);
      this.isStreaming = true;

      console.log('🎤 Аудіо стрімінг запущено (sourceRate:', sourceRate, ')');
      return true;
    } catch (err) {
      console.error('❌ Помилка запуску аудіо стрімінгу:', err);
      throw err;
    }
  }

  /**
   * Ресемплінг аудіо до потрібної частоти (лінійна інтерполяція)
   */
  resampleAudio(data, fromRate, toRate) {
    if (fromRate === toRate) return data;
    const ratio = fromRate / toRate;
    const newLength = Math.round(data.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const pos = i * ratio;
      const index = Math.floor(pos);
      const frac = pos - index;
      if (index + 1 < data.length) {
        result[i] = data[index] * (1 - frac) + data[index + 1] * frac;
      } else {
        result[i] = data[index] || 0;
      }
    }
    return result;
  }

  stop() {
    if (!this.isStreaming) return;

    this.isStreaming = false;

    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    // 🔴 БАГ #2 ВИПРАВЛЕНО: не закриваємо спільний AudioContext!
    // Закриваємо тільки якщо AudioContext створено цим streamer-ом
    if (this.audioContext && this.audioContext !== this.sharedContext) {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    console.log('⏹️ Аудіо стрімінг зупинено');
  }

  float32ToPCM16(float32Array) {
    const pcm16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm16.buffer;
  }

  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

class AudioPlayer {
  constructor() {
    this.audioContext = null;
    this.gainNode = null;
    this.volume = 0.8;
  }

  getContext() {
    return this.audioContext;
  }

  async init() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = this.volume;
      this.gainNode.connect(this.audioContext.destination);
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
  }

  async play(base64Data) {
    try {
      await this.init();

      // Конвертуємо base64 PCM (24kHz) в AudioBuffer
      const binaryStr = atob(base64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const sampleRate = 24000;
      const frameCount = bytes.length / 2;
      const audioBuffer = this.audioContext.createBuffer(1, frameCount, sampleRate);
      const channelData = audioBuffer.getChannelData(0);

      for (let i = 0; i < frameCount; i++) {
        const sample = (bytes[i * 2] | (bytes[i * 2 + 1] << 8));
        channelData[i] = sample / 32768.0;
      }

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.gainNode);
      source.start();

      return new Promise((resolve) => {
        source.onended = resolve;
      });
    } catch (err) {
      console.error('❌ AudioPlayer помилка:', err);
    }
  }

  stop() {
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }
}

/**
 * Візуалізація аудіо (хвилі)
 */
class AudioVisualizer {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas?.getContext('2d');
    this.analyser = null;
    this.animationId = null;
    this.isActive = false;
  }

  start(stream) {
    if (!this.canvas || !this.ctx) return;

    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    source.connect(this.analyser);

    this.isActive = true;
    this.draw();
  }

  draw() {
    if (!this.isActive || !this.ctx || !this.analyser) return;

    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteFrequencyData(dataArray);

    const width = this.canvas.width;
    const height = this.canvas.height;
    const barWidth = (width / bufferLength) * 2;

    this.ctx.clearRect(0, 0, width, height);

    // Градієнт
    const gradient = this.ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, '#4285f4');
    gradient.addColorStop(0.5, '#ea4335');
    gradient.addColorStop(1, '#fbbc05');

    this.ctx.fillStyle = gradient;

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * height;
      const x = i * barWidth + 1;
      this.ctx.fillRect(x, height - barHeight, barWidth - 2, barHeight);
    }

    this.animationId = requestAnimationFrame(() => this.draw());
  }

  stop() {
    this.isActive = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}
