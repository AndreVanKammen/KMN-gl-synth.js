
// TODO: standard place for polyfills if we use them
// navigator.getUserMedia = navigator.getUserMedia || 
//                          navigator.webkitGetUserMedia || 
//                          navigator.mozGetUserMedia;

const defaultOptions = {
  bufferSize: 1024
};

class AudioInput {
  constructor (options) {
    this.options = { ...defaultOptions, ...options };

    // Our buffer
    this.audioBuffer = new Float32Array(this.options.bufferSize * 2.0);

    // And then we need 5! classes to fill it with still a lot of latency :(
    // Gonna need to build my own hardware i guess, latency is so bad I can
    // send it over a network faster which is really SAD, but i guess thats just
    // the case with modern computers. My 286 did realtime 8 bit audio over a 
    // printerport 30 years ago. I'm very disapointed in modern day software/hardware :(
    // Latency from mic is arround 300ms to 500ms now, thats SAD, to compare with a 
    // ping to a PI within my LAN, blocksize of 8192 bytes (the same amount as our 1024 buffersize times 2 float32's):
    // ping 192.168.1.69 -l 8192
    // Pinging 192.168.1.69 with 8192 bytes of data:
    // Reply from 192.168.1.69: bytes=8192 time=8ms TTL=64
    // Reply from 192.168.1.69: bytes=8192 time=7ms TTL=64
    // Reply from 192.168.1.69: bytes=8192 time=6ms TTL=64
    // Reply from 192.168.1.69: bytes=8192 time=7ms TTL=64
    // Thats up and down over WiFi so why on earth does it take more than 200ms to 
    // get samples from the mic which is connect by USB3 to my computer.
    // and no it's not the bufferSize 1024/48000(my sampleRate) = 21ms that fits 15 to 25
    // times in the latency I get. And i use only 5 buffers here (4 on output 1 on input)
    // After more modifications i got it to 250ms, still to slow, synth has ~100ms so 150ms comes from here
    // It could be my webcam mic, maybe try soundcard mic (if i can find one)
    this.stream = undefined;
    this.audioStream = undefined;
    this.audioInput = undefined;
    this.audioContext = undefined;
    this.processor = undefined;
    this.onAudioBuffer = undefined;
  }

  async startCapture() {
    if (navigator.mediaDevices?.getUserMedia)
    {
      this.initializeStream(await navigator.mediaDevices.getUserMedia({
        audio: {
          latency: { exact: 0.010 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          suppressLocalAudioPlayback: false,
          
        }, video: false
      }));
        // this.initializeStream.bind(this),
        // (error) => console.error('getUserMedia failed: ',  error));
    }
    else
    {
      console.error('getUserMedia is not supported in this browser.');
    }
  }

  initializeStream (stream) {
    this.stream = stream;
    // Do i need 2 of these? or should i reuse the output one?
    this.audioContext = new AudioContext({
      latencyHint: 'interactive'  // can also be: 'balanced' 'interactive' 'playback'
    });

    this.audioStream = stream;
    this.audioInput = this.audioContext.createMediaStreamSource(this.audioStream);

    // Well thanks audiocontext i'm not creating a worker to get samples only to have
    // them posted from a different worker back to where i need them. 
    // THATS REALY STUPID AND ADDS MORE LATENCY (just as with the output in my case STUPID ASSUMING API)
    // ScriptProcessor SHOULD NEVER BE DEPRECATED and never can be for these reasons stop beeing so 
    // blindsighted where are you thinking about going with this API it's so confusing, all I
    // want is samples in/out with low latency.
    this.processor = this.audioContext.createScriptProcessor(
      this.options.bufferSize, 
      this.options.channelCount, 
      this.options.channelCount);

    this.processor.onaudioprocess = this.handleAudio.bind(this);
    this.audioInput.connect(this.processor);

    // SO AND THANKS FOR THIS ANNOYING LINE I FORGOT. APPARENTLY I HAVE 
    // TO CONNECT MY processor TO A NOT EXISTING OUTPUT (it has none) FOR IT TO WORK. 
    // NO ERRORS JUST NOTHING, THANKS FOR WASTING MY TIME, REALLY WTF?
    this.processor.connect(this.audioContext.destination);
  }

  handleAudio(event) {
    // Again with the stupidly chosen channel seperation :(
    // This way data from the same time ends up in two different portions of memory, very inneficient
    const samplesL = event.inputBuffer.getChannelData(0);
    const samplesR = event.inputBuffer.getChannelData(1);
    // What if they have different lengths? Oh wait that should never 
    // happen (That's another hint you are doing it wrong Web Audio API)
    this.onAudioBuffer(samplesL, samplesR);

    // let destIX = 0;
    // for (let ix = 0; ix < samplesL.length; ix++) {
    //   this.audioBuffer[destIX++] = samplesL[ix];
    //   this.audioBuffer[destIX++] = samplesR[ix];
    // }
    // if (this.onAudioBuffer) {
    //   this.onAudioBuffer(this.audioBuffer, samplesL.length, this.options.channelCount);
    // }
  }
}

export default AudioInput;
