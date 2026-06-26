/**
 * Gemini Live API Client — Artemis Edition
 * Адаптовано з офіційного прикладу Google:
 * https://github.com/google-gemini/gemini-live-api-examples
 *
 * Підключення до Gemini 3.1 Flash Live через WebSocket з ephemeral token
 */

const MultimodalLiveResponseType = {
  TEXT: 'TEXT',
  AUDIO: 'AUDIO',
  SETUP_COMPLETE: 'SETUP COMPLETE',
  INTERRUPTED: 'INTERRUPTED',
  TURN_COMPLETE: 'TURN COMPLETE',
  TOOL_CALL: 'TOOL_CALL',
  ERROR: 'ERROR',
  INPUT_TRANSCRIPTION: 'INPUT_TRANSCRIPTION',
  OUTPUT_TRANSCRIPTION: 'OUTPUT_TRANSCRIPTION',
};

function parseResponseMessages(data) {
  const responses = [];
  const serverContent = data?.serverContent;
  const parts = serverContent?.modelTurn?.parts;

  try {
    if (data?.setupComplete) {
      responses.push({ type: MultimodalLiveResponseType.SETUP_COMPLETE, data: '', endOfTurn: false });
      return responses;
    }

    if (data?.toolCall) {
      responses.push({ type: MultimodalLiveResponseType.TOOL_CALL, data: data.toolCall, endOfTurn: false });
      return responses;
    }

    if (parts?.length) {
      for (const part of parts) {
        if (part.inlineData) {
          responses.push({ type: MultimodalLiveResponseType.AUDIO, data: part.inlineData.data, endOfTurn: false });
        } else if (part.text) {
          responses.push({ type: MultimodalLiveResponseType.TEXT, data: part.text, endOfTurn: false });
        }
      }
    }

    if (serverContent?.inputTranscription) {
      responses.push({
        type: MultimodalLiveResponseType.INPUT_TRANSCRIPTION,
        data: {
          text: serverContent.inputTranscription.text || '',
          finished: serverContent.inputTranscription.finished || false,
        },
        endOfTurn: false,
      });
    }

    if (serverContent?.outputTranscription) {
      responses.push({
        type: MultimodalLiveResponseType.OUTPUT_TRANSCRIPTION,
        data: {
          text: serverContent.outputTranscription.text || '',
          finished: serverContent.outputTranscription.finished || false,
        },
        endOfTurn: false,
      });
    }

    if (serverContent?.interrupted) {
      responses.push({ type: MultimodalLiveResponseType.INTERRUPTED, data: '', endOfTurn: false });
    }

    if (serverContent?.turnComplete) {
      responses.push({ type: MultimodalLiveResponseType.TURN_COMPLETE, data: '', endOfTurn: true });
    }
  } catch (err) {
    console.warn('⚠️ Помилка парсингу відповіді:', err, data);
  }

  return responses;
}

class GeminiLiveAPI {
  constructor(token, model) {
    this.token = token;
    this.model = model || 'gemini-3.1-flash-live-preview';
    this.modelUri = `models/${this.model}`;

    this.responseModalities = ['AUDIO'];
    this.systemInstructions = '';
    this.voiceName = 'Puck';
    this.temperature = 1.0;
    this.inputAudioTranscription = true;
    this.outputAudioTranscription = true;
    this.enableFunctionCalls = false;
    this.functions = [];
    this.functionsMap = {};

    this.automaticActivityDetection = {
      disabled: false,
      silence_duration_ms: 1000,
      prefix_padding_ms: 500,
      end_of_speech_sensitivity: 'END_SENSITIVITY_HIGH',
      start_of_speech_sensitivity: 'START_SENSITIVITY_UNSPECIFIED',
    };

    this.activityHandling = 'ACTIVITY_HANDLING_UNSPECIFIED';

    this.serviceUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(this.token)}`;

    this.connected = false;
    this.webSocket = null;
    this.lastSetupMessage = null;

    this.onReceiveResponse = () => {};
    this.onOpen = () => {};
    this.onClose = () => {};
    this.onError = () => {};

    // Буфери для аудіо
    this.audioQueue = [];
    this.isPlaying = false;
    this.audioContext = null;
  }

  setSystemInstructions(text) {
    this.systemInstructions = text;
  }

  setVoice(voiceName) {
    this.voiceName = voiceName;
  }

  buildSetupMessage() {
    const setup = {
      model: this.modelUri,
      generationConfig: {
        responseModalities: this.responseModalities,
        temperature: this.temperature,
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: this.voiceName,
          },
        },
        automaticActivityDetection: this.automaticActivityDetection,
        activityHandling: this.activityHandling,
      },
      systemInstruction: {
        parts: [{ text: this.systemInstructions }],
      },
    };

    if (this.inputAudioTranscription) {
      setup.generationConfig.inputAudioTranscription = {};
    }
    if (this.outputAudioTranscription) {
      setup.generationConfig.outputAudioTranscription = {};
    }

    if (this.enableFunctionCalls && this.functions.length > 0) {
      setup.tools = [
        {
          functionDeclarations: this.functions.map(fn => fn.getDefinition()),
        },
      ];
    }

    this.lastSetupMessage = setup;
    return setup;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.webSocket = new WebSocket(this.serviceUrl);
      } catch (err) {
        this.onError('Помилка створення WebSocket: ' + err.message);
        reject(err);
        return;
      }

      let setupDone = false;

      this.webSocket.onopen = async () => {
        console.log('🔗 WebSocket відкрито');
        try {
          const setupMsg = this.buildSetupMessage();
          const bidiPayload = {
            setup: setupMsg,
          };
          this.webSocket.send(JSON.stringify(bidiPayload));
          console.log('📤 Відправлено setup');
        } catch (err) {
          this.onError('Помилка відправки setup: ' + err.message);
          reject(err);
        }
      };

      this.webSocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Перше повідомлення — setupComplete
          if (!setupDone && data?.setupComplete) {
            setupDone = true;
            this.connected = true;
            this.onOpen();
            resolve();
            return; // setupComplete не містить інших даних
          }

          // Нормальна обробка відповідей
          const responses = parseResponseMessages(data);
          for (const response of responses) {
            this.onReceiveResponse(response);
          }
        } catch (err) {
          console.warn('⚠️ Помилка обробки повідомлення:', err);
        }
      };

      this.webSocket.onerror = (event) => {
        console.error('❌ WebSocket помилка:', event);
        this.onError('Помилка WebSocket з'єднання');
        reject(new Error('WebSocket error'));
      };

      this.webSocket.onclose = (event) => {
        this.connected = false;
        console.log('🔌 WebSocket закрито, код:', event.code);
        this.onClose();
      };

      // Таймаут підключення (15 секунд)
      setTimeout(() => {
        if (!setupDone) {
          reject(new Error('Таймаут підключення до Gemini Live API'));
        }
      }, 15000);
    });
  }

  disconnect() {
    if (this.webSocket) {
      this.webSocket.close();
      this.webSocket = null;
    }
    this.connected = false;
    this.audioQueue = [];
    this.isPlaying = false;
  }

  async sendRealtimeInput(input) {
    if (!this.connected || !this.webSocket) {
      console.warn('⚠️ WebSocket не підключено');
      return;
    }

    const payload = {
      realtimeInput: input,
    };

    try {
      this.webSocket.send(JSON.stringify(payload));
    } catch (err) {
      console.error('❌ Помилка відправки:', err);
    }
  }

  sendTextMessage(text) {
    return this.sendRealtimeInput({ text });
  }

  sendAudioChunk(base64Audio) {
    return this.sendRealtimeInput({
      audio: {
        data: base64Audio,
        mimeType: 'audio/pcm;rate=16000',
      },
    });
  }

  sendImageFrame(base64Jpeg) {
    return this.sendRealtimeInput({
      video: {
        data: base64Jpeg,
        mimeType: 'image/jpeg',
      },
    });
  }

  /**
   * Програвання аудіо з Live API
   */
  async initAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  playAudioChunk(base64Data) {
    this.audioQueue.push(base64Data);
    if (!this.isPlaying) {
      this.processAudioQueue();
    }
  }

  async processAudioQueue() {
    if (this.audioQueue.length === 0) {
      this.isPlaying = false;
      return;
    }

    this.isPlaying = true;
    const base64Data = this.audioQueue.shift();

    try {
      await this.initAudioContext();

      // 🔴 БАГ #3 ВИПРАВЛЕНО: перевірка, чи контекст не закрито
      if (!this.audioContext || this.audioContext.state === 'closed') {
        console.warn('⚠️ AudioContext закрито, пропускаємо аудіо');
        this.audioQueue = [];
        this.isPlaying = false;
        return;
      }

      // Конвертуємо base64 PCM в ArrayBuffer
      const binaryStr = atob(base64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      // Створюємо AudioBuffer з PCM даних (24kHz, 16-bit)
      const sampleRate = 24000;
      const frameCount = bytes.length / 2; // 16-bit = 2 bytes per sample
      const audioBuffer = this.audioContext.createBuffer(1, frameCount, sampleRate);
      const channelData = audioBuffer.getChannelData(0);

      // Конвертуємо 16-bit PCM в float32
      for (let i = 0; i < frameCount; i++) {
        const sample = (bytes[i * 2] | (bytes[i * 2 + 1] << 8));
        channelData[i] = sample / 32768.0;
      }

      // Програємо
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);
      source.onended = () => {
        this.processAudioQueue();
      };
      source.start();
    } catch (err) {
      console.error('❌ Помилка програвання аудіо:', err);
      this.processAudioQueue();
    }
  }

  stopPlayback() {
    this.audioQueue = [];
    this.isPlaying = false;
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }
}
