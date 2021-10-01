// Copyright by André van Kammen
// Licensed under CC BY-NC-SA 
// https://creativecommons.org/licenses/by-nc-sa/4.0/

import WebGLSynth from './webgl-synth.js';
import AudioOutput from './audio-output-worklet.js';
import SystemShaders from './webgl-synth-shaders.js';
import defer from '../KMN-utils.js/defer.js';


const defaultOptions = {
  keepInBuffer: 4 * 1024,
  // updateInterval: 1,
  maxNoteLength: 30,
  audioOutput: {
    // audioOutput defaults are defined in defaultOptions of Audio-output
  },
  audioInput: {
  },
  webgl: {
    // webgl synth defaults are defined in webgl-synth.js
  }
}

const spoofBuffer = new Float32Array(4096);

// Handles all interaction betweeen  midiNotes => webglsynth => audioOutput
class SynthController {
  constructor (options) {
    this.options = {...defaultOptions, ...options}
    this.isInitialized = false;

    this.audioInput = undefined;
    this.audioOutput = undefined;
    this.webGLSynth = undefined;

    this.playData = null;

    // this.isStreaming = false;
    // this.isRecording = false;
    // this.audioBuffers = [];
    this.calcTimeAvg = 1;
    this.latencyTimeAvg = 1;
    this.currentLatencyTime = 1;

    this.handleAudioDataRequestBound = this.handleAudioDataRequest.bind(this);
    this.synthOutputTimeDiff = 0.0;
    this.streamMixer = undefined;
  }

  triggerOnTime(timeZone, time, callback) {
    this.ensureStarted();
    return this.playData.triggerOnTime(timeZone, time, callback);
  }

  deleteTrigger(instance) {
    this.ensureStarted();
    return this.playData.deleteTrigger(instance);
  }

  getTime(timeZone) {
    this.ensureStarted();
    return this.playData.getTime(timeZone);
  }

  syncTime(timeZone, time) {
    this.ensureStarted();
    this.playData.syncTime(timeZone, time);
  }

  clearMusic() {
    this.ensureStarted();
    this.playData.clear();
  }

  dispose () {
    if (this.audioOutput) {
      this.audioOutput.dispose();
      this.audioOutput = null;
    }
    if (this.webGLSynth) {
      this.webGLSynth.dispose();
      this.webGLSynth = null;
    }
    this.isInitialized = false;
  }

  getNextBuffer() {
    // this.webGLSynth.gl.clientWaitSync(this.webGLSynth.webGLSync, 0, 10);
    // this.webGLSynth.getCalculatedSamples();
    // let outOfNotes = false;
    for (let ix=0; ix<20; ix++) {
      ++this.analyzeFrameCount;
      if (!this.webGLSynth.calculateSamples()) {
        // outOfNotes = true;
        break
      }
      // this.webGLSynth.synthTime += this.webGLSynth.bufferTime;
      this.webGLSynth.processCount++;
    }

    if (++this.analyzeFrameCount < 10 || !this.haltAnalyze) {
      defer(() => {
        this.getNextBuffer();
      });
    } else {
      this.webGLSynth.stopRecordAnalyze();
      console.log('Processed ',this.analyzeFrameCount,' audio frames in ',(performance.now() - this.speedTestStart).toFixed(2),'ms')
      this.audioOutput.onCalcBuffer = this.handleAudioDataRequestBound;
      this.analyzeResolver();
      this.analyzeResolver = null;
    }
  }

  stopAnalyze() {
    this.haltAnalyze = true;
  }

  async runAnalyze() {
    let result = new Promise((resolve) => {
      this.audioOutput.onCalcBuffer = undefined;

      this.haltAnalyze = false;
      this.speedTestStart = performance.now();
      this.analyzeFrameCount = 0;
      this.analyzeResolver = resolve;

      this.webGLSynth.calculateSamples();
      // this.webGLSynth.synthTime += this.webGLSynth.bufferTime;
      defer(() => {
        this.getNextBuffer();
      });
    });
    return result;
  }

  fpsTest() {
    let start = performance.now();
    let stop = start;
    let synthTime = this.webGLSynth.synthTime;
    let processCount = this.webGLSynth.processCount;
    let loopCount = 0;
    while (((stop = performance.now())-start) < 1000) {
      this.webGLSynth.synthTime = synthTime;
      this.webGLSynth.processCount = processCount;
      this.webGLSynth.calculateSamples();
      // this.webGLSynth.getCalculatedSamples()
      this.webGLSynth.gl.clientWaitSync(this.webGLSynth.webGLSync, 0, 10);
      loopCount++;
    }
    console.log('Processed ',loopCount,' audio frames in ',(stop-start).toFixed(2),'ms')
  }

  // /**
  //  * Set's the track for us by the playinput shader
  //  * TODO rename playinput to plattrack
  //  * @param {IAudioTracks} audioTracks 
  //  */
  // setAudioStreams(audioTracks) {
  //   this.ensureStarted();
  //   // TODO: Make better system then this hack, if you call this twice it weill mess up
  //   this.streamBuffer = this.webGLSynth.createStreamBuffer();
  //   // TODO: Every track can have it's own sampleRate
  //   // streamBuffer.sampleRate = audioData.sampleRate;
  //   // TODO: Consider other then stereo?
  //   this.divider = 0;
  //   this.streamBuffer.onGetData = audioTracks.getData.bind(audioTracks);
  //   (buffer, streamNr, trackNr, streamFloatSize, bufferOffset, startSampleNr, count) => {
  //     let ofs = bufferOffset;
  //     let sNr = startSampleNr;
  //     let audioTrack = audioTracks.tracks[trackNr % audioTracks.tracks.length];
  //     let bufStart = streamNr * streamFloatSize;
  //     let l = audioTrack.leftSamples || emptyArray; 
  //     let r = audioTrack.rightSamples || emptyArray; 
  //     // if ((this.divider++ & 0x180) === 0x180) {
  //     //   console.log('get sample: ',streamNr, ofs, ofs % trackSize2,startSampleNr,count);
  //     // }
  //     if ((bufStart + ofs) % 2 !== 0) {
  //       debugger
  //     }
  //     for (let ix = 0; ix < count; ix++) {
  //       buffer[bufStart + (ofs++ % streamFloatSize)] = l[sNr] || 0.0;
  //       buffer[bufStart + (ofs++ % streamFloatSize)] = r[sNr++] || 0.0;
  //     }
  //   };
  // }

  handleAudioDataRequest () {
    let newOutputTimeDiff = 
      (this.webGLSynth.synthTime - (this.audioOutput.dataInBuffer) / this.sampleRate) -
      this.audioOutput.audioCtx.getOutputTimestamp().contextTime;
    
    if (Math.abs(this.synthOutputTimeDiff - newOutputTimeDiff) > 0.5) {
      // console.log('resync time',
      //   this.synthOutputTimeDiff - newOutputTimeDiff,
      //   this.audioOutput.contextTimeOnPost,
      //   this.audioOutput.bufferEmptyCount,
      //   this.audioOutput.dataInBuffer,
      //   this.options.keepInBuffer);
      this.synthOutputTimeDiff = newOutputTimeDiff;
    } else {
      this.synthOutputTimeDiff = this.synthOutputTimeDiff * 0.9999 + 0.0001 * newOutputTimeDiff;
    }

    // console.log('!', this.audioOutput.dataInBuffer);
    while (this.audioOutput.dataInBuffer < this.options.keepInBuffer) {
      // console.log('.', this.audioOutput.dataInBuffer);
      let start = globalThis.performance.now();
      // this.audioOutput.postBuffer(spoofBuffer)
      if (this.webGLSynth.samplesCalculated) {
        if (!this.webGLSynth.checkSamplesReady()) {
          setTimeout(this.handleAudioDataRequestBound,3);
          return;
        } else {
          this.audioOutput.postBuffer(this.webGLSynth.getCalculatedSamples());
        }
      } else {
        this.webGLSynth.calculateSamples();
        
        // this.startTime += this.webGLSynth.bufferWidth / this.sampleRate;
      }
      let stop = globalThis.performance.now();

      this.calcTimeAvg = this.calcTimeAvg * 0.99 + 0.01 * (stop - start);
    }
   
    this.currentLatencyTime = (((this.audioOutput.dataInBuffer) / this.sampleRate) * 1000);
    this.latencyTimeAvg = this.latencyTimeAvg * 0.999 + 0.001 * this.currentLatencyTime;
  }

  get playSynthTime() {
    let outputTime = this.audioOutput.audioCtx.getOutputTimestamp().contextTime;
    return outputTime  + this.synthOutputTimeDiff;
  }
  getSynthShaderCode(name) {
    // Default to system shader stuff
    return SystemShaders[name];
  }
  getEffectShaderCode(name) {
    // Default to system shader stuff
    return SystemShaders[name];
  }

  // Since we can only start audiocontext from events
  ensureStarted () {
    if (!this.isInitialized) {
      this.isInitialized = true;

      this.audioOutput = new AudioOutput(this.options.audioOutput);
      this.audioOutput.onCalcBuffer = this.handleAudioDataRequestBound;
      this.audioOutput.ensureStarted();

      // Sync audio parameters between components
      this.sampleRate   = this.options.webgl.sampleRate   = this.audioOutput.sampleRate;
      this.channelCount = this.options.webgl.channelCount = this.audioOutput.channelCount;  

      this.webGLSynth = new WebGLSynth({
        ...this.options.webgl,
        getSynthShaderCode: this.getSynthShaderCode.bind(this),
        getEffectShaderCode: this.getEffectShaderCode.bind(this)
      });

      // this.maxTracks = this.webGLSynth.bufferHeight;

      // Get the main playdata from the webgl synth
      this.playData = this.webGLSynth.getPlayData();
    }
  }
}

export default SynthController;
