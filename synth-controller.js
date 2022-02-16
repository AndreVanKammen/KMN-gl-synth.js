// Copyright by André van Kammen
// Licensed under CC BY-NC-SA 
// https://creativecommons.org/licenses/by-nc-sa/4.0/

import WebGLSynth from './webgl-synth.js';
import { AudioOutputSD, AudioOutputShared } from './audio-output-worklet-shared.js';
import AudioOutput from './audio-output-worklet.js';
import SystemShaders from './webgl-synth-shaders.js';
import defer from '../KMN-utils.js/defer.js';


const defaultOptions = {
  keepInBuffer: 1 * 1024,
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

  syncTime(timeZone, time, thight = false) {
    this.ensureStarted();
    this.playData.syncTime(timeZone, time, thight);
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
  
  handleNewBuffer() {
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
      this.isAnalyzing = false;
      this.analyzeResolver();
      this.analyzeResolver = null;
    }
  }

  stopAnalyze() {
    this.haltAnalyze = true;
  }

  async runAnalyze() {
    let result = new Promise((resolve) => {
      this.isAnalyzing = true;
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

  handleWorkerData() {
    while (this.audioOutput.dataInBuffer < this.options.keepInBuffer) {
      this.webGLSynth.calculateSamples();
      this.audioOutput.postBuffer(this.webGLSynth.getCalculatedSamples());
    }
  }

  handleAudioDataRequest() {
    while (this.audioOutput.dataInBuffer < this.options.keepInBuffer + this.webGLSynth.bufferWidth) {
      // console.log('.', this.audioOutput.dataInBuffer);
      let start = globalThis.performance.now();
      // this.audioOutput.postBuffer(spoofBuffer)
      if (this.webGLSynth.samplesCalculated) {
        if (!this.webGLSynth.checkSamplesReady()) {
          let maxTimeOut = 0;//Math.max(0, (this.audioOutput.dataInBuffer / this.channelCount / this.sampleRate) * 1000 - 1);
          // TODO This won't work in workers but the wait for fence is also broken in workers :(
          setTimeout(this.handleAudioDataRequestBound, Math.min(3, maxTimeOut));
          return;
        } else {
          // console.log('!', this.audioOutput.dataInBuffer);
          // // @ts-ignore: Check if shared data available
          // @ts-ignore That's why I'm checking it
          if (this.audioOutput.sd) {
            // @ts-ignore That's why I checked it
            this.webGLSynth.getCalculatedSamples(this.audioOutput.sd);
          } else {
            this.audioOutput.postBuffer(this.webGLSynth.getCalculatedSamples());
            this.handleNewBuffer();
          }
        }
      } else {
        this.webGLSynth.calculateSamples();
        
        // this.startTime += this.webGLSynth.bufferWidth / this.sampleRate;
      }
      let stop = globalThis.performance.now();

      this.calcTimeAvg = this.calcTimeAvg * 0.99 + 0.01 * (stop - start);
      // console.log('this.calcTimeAvg', this.calcTimeAvg.toFixed(2));
    }
       
    let newOutputTimeDiff =
      (this.webGLSynth.synthTime - (this.audioOutput.dataInBuffer / this.channelCount) / this.sampleRate) -
      this.audioOutput.getContextTime();// audioCtx.getOutputTimestamp().contextTime;
    
    if (Math.abs(this.synthOutputTimeDiff - newOutputTimeDiff) > 0.5) {
      // console.log('resync time',
      //   this.synthOutputTimeDiff - newOutputTimeDiff,
      //   this.audioOutput.contextTimeOnPost,
      //   this.audioOutput.bufferEmptyCount,
      //   this.audioOutput.dataInBuffer,
      //   this.options.keepInBuffer);
      this.synthOutputTimeDiff = newOutputTimeDiff;
    } else {
      this.synthOutputTimeDiff = this.synthOutputTimeDiff * 0.99 + 0.01 * newOutputTimeDiff;
    }

    this.currentLatencyTime = (((this.audioOutput.dataInBuffer / this.channelCount) / this.sampleRate) * 1000);
    this.latencyTimeAvg = this.latencyTimeAvg * 0.99 + 0.01 * this.currentLatencyTime;
  }

  get playSynthTime() {
    let outputTime = this.audioOutput.getContextTime();
    return outputTime + this.synthOutputTimeDiff - this.latencyTimeAvg / 1000.0;
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

      if (this.options.useSharedArrayBuffer && globalThis.SharedArrayBuffer) {
        if (this.options.sharedArray) {
          console.info('Audio output to SharedArrayBuffer');
          // TODO: make it auto-switching for shared memory version or not
          this.audioOutput = new AudioOutputSD({
            sharedArray: this.options.sharedArray,
            ...this.options.audioOutput
          });
        } else {
          console.info('Audio output to AudioOutputShared');
          this.audioOutput = new AudioOutputShared(this.options.audioOutput);
        }
      } else {
        console.info('Audio output with postMessage');
        this.audioOutput = new AudioOutput(this.options.audioOutput);
      }
      this.audioOutput.onCalcBuffer = this.handleAudioDataRequestBound;
      let blockSize = this.options.webgl.bufferWidth * this.audioOutput.options.channelCount;
      this.audioOutput.ensureStarted(this.options.keepInBuffer / blockSize + 2, blockSize);

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
