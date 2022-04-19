import SynthPlayData, { SynthNote } from "./webgl-synth-data.js";
import WebGLSynth from "./webgl-synth.js";

export const emptyFloat64Array = new Float32Array();

export class StreamBuffer {
  /**
   * 
   * @param {WebGLSynth} synth 
   */
  constructor (synth, playData) {
    this.synth = synth;  
    this.playData = synth.playData;

    this.historySamples = 32; // TODO: CHANGING THIS TO 16 or 1024 INFLUENCES BEAT DETECTION IN HURRICANE
    this.streamBlocks = 8;
    this.streamCount = ~~(512 / this.streamBlocks);
    this.streamVec4Count = ~~(this.streamBlocks * synth.bufferWidth);
    this.streamFloatSize = ~~(this.streamVec4Count * 4);

    this.bufferData = new Float32Array(this.streamCount * this.streamFloatSize);
    for (let ix = 0; ix < this.bufferData.length; ix++) {
      this.bufferData[ix] = 1234.5678; //Math.sin(ix/2.0);
    }
    const gl = this.synth.gl;
    gl.activeTexture(gl.TEXTURE3)
    this.textureInfo = gl.createOrUpdateFloat32TextureBuffer(this.bufferData,{bufferWidth:synth.bufferWidth});
    
    // TODO: Consider other then stereo?
    /** @type {(noteEntry: SynthNote, synthTime?:number)=> {left:Float32Array,right:Float32Array}} */
    this.onGetData = (noteEntry) => ({ left: emptyFloat64Array, right: emptyFloat64Array });

    this.streamData = {};
    this.streamUsed = 0;

    this.firstChange = this.bufferData.length;
    this.lastChange = 0;
  }

  getStreamNr(trackNr) {
    // Every track/note gets it's own stream nr so we can play the same note twice
    const streamNr = this.streamUsed % this.streamCount; 
    this.streamData[streamNr] = {
      lastOffset: ~~0,
      lastTime: Infinity,
      channelCount: ~~2,
      sampleRate: ~~44100
    };
    this.streamUsed++;
    return streamNr;
  }
  /**
   * 
   * @param {{left:Float32Array,right:Float32Array}} leftRight 
   * @param {number} streamNr
   * @param {Float32Array} buffer 
   * @param {number} bufferOffset 
   * @param {number} bufferSize 
   * @param {number} startSampleNr 
   * @param {number} count 
   */
  _fillBufferLR(leftRight, streamNr, buffer, bufferOffset, bufferSize, startSampleNr, count) {
    let l = leftRight.left;
    let r = leftRight.right;
    let sNr = startSampleNr;
    let bufStart = streamNr * bufferSize;
    let ofs = bufferOffset;
    for (let ix = 0; ix < count; ix++) {
      buffer[bufStart + (ofs++ % bufferSize)] = l[sNr] || 0.0;
      buffer[bufStart + (ofs++ % bufferSize)] = r[sNr++] || 0.0;
    }
  };

  /**
   * 
   * @param {SynthNote} noteEntry 
   * @param {number} synthTime
   */
  fill(noteEntry, synthTime) {
    let time = synthTime - noteEntry.phaseTime + noteEntry.audioOffset;
    let streamNr = noteEntry.streamNr;
    //console.log(time, trackNr);
    let streamData = this.streamData[streamNr];
    if (streamData.lastTime !== time) {

      const startSampleNr = ~~Math.round(time * streamData.sampleRate);
      const minOffset = ~~Math.max(~~0,~~(startSampleNr - this.historySamples) * streamData.channelCount);

      // debug to check filling
      // for (let ix = bufStart; ix < bufStart + this.streamSize * 2; ix++) {
      //   this.bufferData[ix] = Math.sin(ix/5.0);
      // }
      // streamData.lastOffset = minOffset;

      // Back in time or to far in the future use minOffset
      if (time < streamData.lastTime || streamData.lastOffset < minOffset) {
        streamData.lastOffset = minOffset;
      }

      const samplesPerVec4 = ~~(4 / streamData.channelCount);
      const bufStart = ~~(streamNr * this.streamFloatSize);
      const sampleFutureCount = ~~(this.streamVec4Count * samplesPerVec4 - this.historySamples);

      const maxSampleNr = ~~(startSampleNr + sampleFutureCount);
      const sampleOffset = ~~(streamData.lastOffset / streamData.channelCount);
      const sampleCount = ~~(maxSampleNr - sampleOffset);
      
      // TODO More possible paths for other data formats
      let leftRight = this.onGetData(noteEntry,synthTime);
      this._fillBufferLR(leftRight, streamNr, this.bufferData, streamData.lastOffset, this.streamFloatSize, sampleOffset, sampleCount);

      this.firstChange = Math.min(this.firstChange, bufStart);
      this.lastChange = Math.max(this.lastChange, bufStart + this.streamVec4Count*4);
      // this.firstChange = Math.min(this.firstChange, bufStart + track.lastOffset % trackSize2);
      // this.lastChange = Math.max(this.lastChange, bufStart + track.lastOffset % trackSize2);
      streamData.lastOffset += sampleCount * 2;
      // this.firstChange = Math.min(this.firstChange, bufStart + track.lastOffset % trackSize2);
      // this.lastChange = Math.max(this.lastChange, bufStart + track.lastOffset % trackSize2);
  
      streamData.lastTime = time;
    }
  }

  update() {
    // TODO: partial update
    // 28sec for 2021 buffers full update of texture 128 tracks 14 tracks playing @1ce
    // 14sec for 2021 buffers full update of texture 128 tracks 14 tracks playing @1ce
    // 1.3 sec with no fill for 2021 buffers
    // 1.5 sec with fill bug for 2021 buffers
    // 2 sec with partial update workingg for 2021 buffers 4 * 1024 tracksize
    // 2 sec with partial update workingg for 2021 buffers 4 * 1024 tracksize and lowpass on 
    // 18 sec for 10021 buffers with 2048 sample low pass, samples are interpolated so 4096 reads per sample
    // 3.6 second for single track with crossfade to other track for 10021 buffers  lowpass 1024 samples * 2
    // 10021 buffers id 232.687 seconds of music
    // 6.6 seconds for pinkfloyds great gig midi (doesn't use this code but a lot of notes with room effects)
    if (this.firstChange !== this.bufferData.length) {
      this.textureInfo = this.synth.gl.createOrUpdateFloat32TextureBuffer(this.bufferData, this.textureInfo, this.firstChange, this.lastChange);
    }
    this.firstChange = this.bufferData.length;
    this.lastChange = 0;
  }
}
