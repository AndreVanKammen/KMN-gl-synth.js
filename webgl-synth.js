// Copyright by André van Kammen
// Licensed under CC BY-NC-SA
// https://creativecommons.org/licenses/by-nc-sa/4.0/

import getWebGLContext from '../KMN-utils.js/webglutils.js';
import SystemShaders from './webgl-synth-shaders.js';
import SynthPlayData, { ControlHandler, ControlBase, SynthBaseEntry, SynthMixer, SynthNote } from './webgl-synth-data.js';
import { otherControls } from './otherControls.js';
import { TrackLineInfo, WebGLMemoryManager } from './webgl-memory-manager.js';
import { AudioOutputSharedData } from './audio-worklet-shared.js';
import { SynthShaderManager, vertextPull } from './webgl-synth-shader-manager.js';

// https://stackoverflow.com/questions/53562825/glreadpixels-fails-under-webgl2-in-chrome-on-mac
// Fix needed for Linux Mac & android
// TODO Find out if it's still the case and if only for readPixels we only need to make the output buffer 4 componets
const force4Components = true; // Setting to false doesn't give memory saving in chrome on my GTX1070 not in OpenGL and not in default render settings
// Using OpenGl in chrome ANGLE graphics back-end saves some additional 25% GPU memory but gives more lag when shaders are run for the 1st time
// D3D11on12 behaves the same as OpenGL
// D3D9 DOESN'T work, looks like webgl2 support missing
// D3D11 same memory savings (maybe it was reloading the browser) meory usage still the same with force4Components = true
// Back on default memory is lower again. opening debugger once also increases GPU memory a lot (Dedicated GPU in
const useTexStorage = true;
const mixdownShader = '#mixdown';
// const vertextPull = true;

// Got to 3.5GB of memory usage, more seems to crash webgl in the page
const defaultOptions = {
  sampleRate: 44100,
  maxNotes: 512,
  bufferWidth: 512, // 1024,
  bufferHeight: 1024,
  bufferCount: 64, // Is for source and target so 2 times as big
  channelCount: 2, // Actualy only 2 will work for now because all shaders are stereo
  outputBufferCount: 1 // Number of output lines read from the GPU
};

const outputBufferCycleCount = 2;

class WebGLSynth {
  constructor(options) {
    this.options = { ...defaultOptions, ...options };
    this.bufferWidth = ~~this.options.bufferWidth;
    this.bufferHeight = ~~this.options.bufferHeight;
    this.bufferCount = ~~this.options.bufferCount;
    this.sampleRate = ~~this.options.sampleRate;
    this.componentCount = ~~this.options.channelCount;
    this.bufferTime = this.bufferWidth / this.options.sampleRate;
    this.canvas = this.options.canvas;
    this.maxNotes = this.options.maxNotes;
    this.maxAttrOfs = 0;

    this.webGLSync = [];

    this.lastEntryCount = 0;
    this.stopOutput = false;
    this.recordAnalyze = false;

    if ((!this.options.getSynthShaderCode) ||
        (!this.options.getEffectShaderCode)) {
      console.error('No shader code getter suplied!')
    }

    this.getSynthShaderCode = this.options.getSynthShaderCode;
    this.getEffectShaderCode = this.options.getEffectShaderCode;

    if (!this.canvas) {
      if (globalThis.OffscreenCanvas) {
        this.canvas = new globalThis.OffscreenCanvas(this.bufferWidth, this.bufferHeight);
      } else {
        this.canvas = document.createElement('canvas');
      }
    }
    this.canvas.width = this.bufferWidth;
    this.canvas.height = this.bufferHeight;

    this.averageRead = 1.0;

    let gl = (this.gl = getWebGLContext(this.canvas, { alpha: true }));
    this.shaders = new SynthShaderManager(this);

    // const formatIndex = this.componentCount - 1;
    // TODO: set all to 4 components
    this.glInternalFormat = force4Components ? gl.RGBA32F : gl.RG32F;//[gl.R32F, gl.RG32F, gl.RGB32F,gl.RGBA32F][formatIndex];
    this.glFormat = force4Components ? gl.RGBA : gl.RG;//[gl.RED, gl.RG, gl.RGB, gl.RGBA][formatIndex];
    // this.glInternalFormat = [gl.R32F, gl.RG32F, gl.RGB32F,gl.RGBA32F][formatIndex];
    // this.glFormat = [gl.RED, gl.RG, gl.RGB, gl.RGBA][formatIndex];

    this.floatWidth = this.bufferWidth * this.componentCount;

    //set to RGBA, FIX FOR LINUX, MAC & ANDROID;
    this.floatWidthGPU = force4Components ? this.bufferWidth * 4 : this.floatWidth;

    this.setOutputCount(this.options.outputBufferCount);

    this.sampleTextures = [
      this.createSampleTextures(this.bufferCount),
      this.createSampleTextures(this.bufferCount)
    ];

    // Back buffers for use in fourier transform params injection in next pass
    this.inputBackTexture = this.createBackBufferTexture(this.bufferHeight); // TODO dynamic size?
    this.outputBackTexture = this.createBackBufferTexture(this.bufferHeight); // Needs to be bufferheight size
    this.inputBackFBO = this.createFBOforTexture(this.inputBackTexture);
    this.outputBackFBO = this.createFBOforTexture(this.outputBackTexture);

    this.audioOutputBuffer = new Float32Array(this.bufferWidth * 2);

    this.lineCount = this.bufferHeight * this.bufferCount * 2
    this.rmsAvgEngMaxAttributeBuffer = new Float32Array(this.bufferHeight * this.bufferCount * 2 * 4)
    this.rmsAvgBuffer = this.createRmsAvgEngMaxTextures(this.lineCount / this.bufferWidth)

    this.readRmsAvgEngMaxBuffer = new Float32Array(this.lineCount * 4);

    this.volumeInfo = { texture:undefined, size:0, bufferWidth: 1024 };
    this.vertexPullTexture = { texture:undefined, size:0, bufferWidth: 1024 };

    if (vertextPull) {
      this.zeroShader = this.shaders.getProgram(SystemShaders.vertexPull, SystemShaders.zero);
      this.mixDownShader = this.shaders.getProgram(SystemShaders.vertexPull, SystemShaders.mixdown);
    } else {
      this.zeroShader = this.shaders.getProgram(SystemShaders.vertex, SystemShaders.zero);
      this.mixDownShader = this.shaders.getProgram(SystemShaders.vertex, SystemShaders.mixdown);
    }
    this.copyLineShader = this.shaders.getProgram(SystemShaders.copyLineVertex, SystemShaders.copyLine);
    this.rmsAvgEngMaxValueShader = this.shaders.getProgram(SystemShaders.rmsAvgEngMaxVertex, SystemShaders.rmsAvgEngMax);

    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    let ext = gl.getExtension('EXT_color_buffer_float');
    if (!ext) {
      console.error('EXT_color_buffer_float is not supported on this device which is needed for this software!');
    }
    ext = gl.getExtension('EXT_float_blend');
    if (!ext) {
      console.error('EXT_float_blend is not supported on this device which is needed for this software!');
    }

    this.backBufferTestBuffer = new Float32Array(this.bufferWidth * 1 * 4);

    // Did we send the data to the videocard?
    this.samplesCalculated = false;

    // Counter which increases for every outputBuffer
    // used for calculating circular buffer positions
    this.processCount = 0;
    this.lastMaxValue = 0;

    // Attribute buffers for sending to videocard
    // TODO size is way to big, needs a maxtracks
    this.attributeLineBuffer = new Float32Array(this.maxNotes * 8);//this.bufferHeight * 2 * 4 * this.bufferCount * 2 );
    if (vertextPull) {
      this.vertexPullBuffer = new Float32Array(this.maxNotes * (8 + 4 + 4));//this.bufferHeight * 2 * 4 * this.bufferCount * 2 );
    } else {
      this.attributeLineBuffer2 = new Float32Array(this.maxNotes * 8);//this.bufferHeight * 2 * 4 * this.bufferCount * 2 );
      this.attributeLineBuffer3 = new Float32Array(this.maxNotes * 8);//this.bufferHeight * 2 * 4 * this.bufferCount * 2 );
    }

    this.lastBufferLevel = 0;

    this.correctiveVolume = 0.25;

    this.nanCount = 0;
    this.infiniteCount = 0;

    this.playData = new SynthPlayData(this);
    this.synthTime = 0.0;
    this.totalEntryTime = 0.0;

    if (this.options.analyzer) {
      this.options.analyzer.setSynth(this);
    };
    this.currentBackBufferIx = 0;

    this.memoryManager = new WebGLMemoryManager(this);

    this.automaticVolume = false;

    this.addBackBufferToSampleFBO(); // 20ms< for 1000 times

    this.outputMultiplier = 1.0;
    // this.controlConverters = {};
    // this.controlConverters[7] = 'pow(10.0, 0.8685889638065035 * log(value))';
  }

  // This is the thing you fill with notes to play
  getPlayData() {
    return this.playData;
  }
  dispose() {
    // TODO
  }

  setOutputCount(outputBufferHeight) {
    this.outputBufferHeight = outputBufferHeight;
    // TODO Cleanup of buffers and texture
    // if (this.outputTexture) {
    //   this.gl.deleteTexture(this.outputTexture
    // }
    this.outputTexture = this.createSampleTextures(outputBufferCycleCount, outputBufferHeight);
    // The buffer for reading the output of the videocard
    this.readSampleBuffer = new Float32Array(this.floatWidthGPU * this.outputBufferHeight);
  }

  startRecordAnalyze(bufferSize, fragmentWidth, step) {
    this.recordAnalyzeHeight = ~~Math.ceil(bufferSize / this.bufferWidth);
    this.recordAnalyzeBuffer = this.createRmsAvgEngMaxTextures(this.recordAnalyzeHeight);
    this.recordAnalyzeMultiplier = this.bufferWidth / fragmentWidth;
    this.recordAnalyzeStep = step;
    const gl = this.gl;
    gl.viewport(0, 0, this.bufferWidth, this.recordAnalyzeHeight);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.recordAnalyze = true;
    return this.recordAnalyzeBuffer;
  }

  stopRecordAnalyze() {
    this.recordAnalyze = false;
    this.recordAnalyzeBuffer = null;
  }


// #region "Texture and buffer creation"
// ******************************************
// *********** Textures and buffers *********
// ******************************************
  createRmsAvgEngMaxTextures(height) {
    const gl = this.gl;

    gl.activeTexture(gl.TEXTURE0);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

    const makeTex = (attachment) => {
      const result = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, result);
      if (useTexStorage) {
        gl.texStorage2D(gl.TEXTURE_2D, 1,
           gl.RGBA32F,
           this.bufferWidth,
           height);
      } else {
       gl.texImage2D(gl.TEXTURE_2D, 0,
           gl.RGBA32F,
           this.bufferWidth,
           height,
           0,
           gl.RGBA,
           gl.FLOAT, null);
      }
      gl.texParamNearestClamp(gl.TEXTURE_2D);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment,
                            gl.TEXTURE_2D, result, 0);
      return result;
    }
    return {
      fbo,
      leftTex: makeTex(gl.COLOR_ATTACHMENT0),
      rightTex: makeTex(gl.COLOR_ATTACHMENT1)
    }
    // this.rms_avg_eng_max_left = makeTex(gl.COLOR_ATTACHMENT0);
    // this.rms_avg_eng_max_right = makeTex(gl.COLOR_ATTACHMENT1);
  }

  createBackBufferTexture(height = this.bufferHeight) {
    const gl = this.gl;
    let texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (useTexStorage) {
      gl.texStorage2D(
        gl.TEXTURE_2D,
        1,
        gl.RGBA32F,
        this.bufferWidth,
        height);
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        this.bufferWidth,
        height,
        0,
        gl.RGBA,
        gl.FLOAT,
        null
      );
    }
    gl.texParamNearestClamp(gl.TEXTURE_2D);
    return texture;
  }

  // TODO move to utils
  createFBOforTexture(texture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE10);
    let result = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, result);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
       gl.TEXTURE_2D, texture, 0);

    return result;
  }

  addBackBufferToSampleFBO() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE10);
    for (let sampleBufferNr = 0; sampleBufferNr < this.sampleTextures.length; sampleBufferNr++) {
      const buffers = this.sampleTextures[sampleBufferNr].buffers;

      for (let ix = 0; ix < buffers.length; ix++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, buffers[ix]);
        gl.bindTexture(gl.TEXTURE_2D, this.outputBackTexture);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1,
           gl.TEXTURE_2D, this.outputBackTexture, 0);
      }
    }
  }

  createSampleTextures(bufferCount, height = this.bufferHeight) {
    const gl = this.gl;

    let texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    if (useTexStorage) {
      gl.texStorage3D(
        gl.TEXTURE_2D_ARRAY,
        1,
        this.glInternalFormat,
        this.bufferWidth,
        height,
        bufferCount);
    } else {
      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        this.glInternalFormat,
        this.bufferWidth,
        height,
        bufferCount,
        0,
        this.glFormat,
        gl.FLOAT,
        null
      );
    }

    gl.texParamNearestClamp(gl.TEXTURE_2D_ARRAY);

    let buffers = [];
    for (var ix=0; ix < bufferCount; ix++) {
      let buffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
      gl.framebufferTextureLayer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        texture,
        0,
        ix
      );
      buffers.push(buffer);
    }
    return {
      texture,
      buffers
    }
  }
// #endregion

  /** @param {ControlBase} channelControls */
  loadChanelControls(channelControls) {
    if (channelControls.updateControlBuffer(this.synthTime, this.bufferTime)) {

      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE2);
      gl.createOrUpdateFloat32TextureBuffer(
        channelControls.controlBuffer,
        channelControls.texInfo );
    }
  }
  /** @param {{ entry: SynthNote, shader:string, isEffect:boolean }[]} tracks */
  calculateShader_VertexPull(tracks, passNr) {
    const gl = this.gl;

    const vb = this.vertexPullBuffer;
    const a2ofs = 8;
    const a3ofs = 12;

    let channelControl = null

    // Convert track data to attribute data for shader
    let attrOfs = 0;
    let backBufferLines = undefined;

    const shaderName = tracks[0].shader;
    const isEffect = tracks[0].isEffect;
    // Streambuffer comes from the 1st entry, this should al be the same shader and streambuffer
    // TODO: Make sure that calculateShader get called per streambuffer instance
    const streamBuffer = tracks[0].entry.mixer.streamBuffer;

    for (let trackIX = 0; trackIX < tracks.length; trackIX++) {
      let entry = tracks[trackIX].entry;
      const tli_out = entry.runBuffers[passNr];
      // No buffer allocated, can't do anything
      if (tli_out.start === -1) {
        continue;
      }

      let trackLineIx = tli_out.current % this.bufferHeight;
      let lineY = -1.0 + ((trackLineIx + 0.5) / this.bufferHeight) * 2.0;
      const controlTime = this.synthTime;// + this.bufferTime * 0.5;
      // TODO: There is only 1 channel here so we can calculatr this once
      let pitchRange = entry.channelControl.getControlAtTime(controlTime, otherControls.pitchRange, 2.0) || 2.0;
      let pitch = entry.channelControl.getControlAtTime(controlTime, otherControls.pitch, 0.0) || 0.0;
      let playDirection = entry.getPlayDirection(controlTime);

      if (streamBuffer) {
        if (entry.streamNr < 0) {
          entry.streamNr = streamBuffer.getStreamNr(entry.note);
        }
        streamBuffer.fill(entry, this.synthTime);
        // console.log('Volume: ',entry.channelControl.getControlAtTime(controlTime , 7, 0.0));
      }
      if (tli_out.outputCount > 1) {
        console.log('synth outputcount: ', tli_out.outputCount);
      }
      for (let oIX = 0; oIX < tli_out.outputCount; oIX++) {
        // TODO this now works because of grouping per channel
        channelControl = entry.channelControl;
        let outputLineIx = tli_out.getCurrentOutput(oIX) % this.bufferHeight;

        let lineY2 = -1.0 + ((outputLineIx + 0.5) / this.bufferHeight) * 2.0;
        vb[attrOfs + 0] = this.synthTime - entry.time;
        vb[attrOfs + 1] = lineY2
        vb[attrOfs + 3] = entry.releaseTime;

        vb[attrOfs + 4] = this.synthTime - entry.time + this.bufferTime;
        vb[attrOfs + 5] = lineY2;

        // Only apply time stretching on pass 0 for pitchbends on notes
        if (passNr !== 0 || oIX !== 0) {
          vb[attrOfs + 2] = this.synthTime - entry.time;
          vb[attrOfs + 6] = this.synthTime - entry.time   + this.bufferTime;
        } else {
          vb[attrOfs + 2] = this.synthTime - entry.phaseTime + entry.audioOffset;
          if (streamBuffer) {
            // Substract from the phaseTime to get more accurate samples
            vb[attrOfs + 2] = vb[attrOfs + 2] % (streamBuffer.streamFloatSize / this.sampleRate);
            // console.log(vb[attrOfs + 2]);
          }

          // Calculation for pitch by timeshift, if we change the frequency in
          // the shader we would need phase corrections, by stretching time
          // we avoid this because the shader can just repeat it's stateless
          // cycle. All intruments get a working pitchbend this way so it seemed
          // like the best option dispite it being kind off a hack
          // Calculate the frequency ratio of the normal and bend note
          // let frequencyRatio = Math.pow(2.0, (entry.note + pitchRange * pitch) / 12.0)
          //                    / Math.pow(2.0, entry.note / 12.0); // note didn't matter so removed for constant
          let frequencyRatio = Math.pow(2.0, (12.0 + pitchRange * pitch) / 12.0) / 2.0;
          // removed constant value / Math.pow(2.0, 12.0 / 12.0);
          // Get the difference as a fraction of the total time
          let timeShift = this.bufferTime * (1.0 - frequencyRatio);
          timeShift += (this.bufferTime - this.bufferTime * playDirection);
          let bufferLengthInTime = this.bufferTime - timeShift

          vb[attrOfs + 6] = vb[attrOfs + 2] + bufferLengthInTime;

          // if (playDirection < 0.0) {
          //   let correction = bufferLengthInTime / this.bufferWidth * 1.0;
          //   a1[attrOfs + 6] -= correction;
          //   a1[attrOfs + 2] += correction;
          // }

          // And change the track startTime
          entry.phaseTime += timeShift;
        }
        vb[attrOfs + 7] = entry.releaseTime;

        // Parameters that change per line so they can't be done in uniforms
        vb[attrOfs + a2ofs + 0] = vb[attrOfs + a2ofs + 4] = (!!streamBuffer) ? entry.streamNr : entry.note;
        vb[attrOfs + a2ofs + 1] = vb[attrOfs + a2ofs + 5] = entry.velocity;

        entry.updateNoteControls && entry.updateNoteControls(this.synthTime);
        vb[attrOfs + a2ofs + 2] = entry.lastReleaseVelocity || 0.0;
        //vb[attrOfs + a2ofs + 6] = entry.newReleaseVelocity || 0.0;
        vb[attrOfs + a2ofs + 3] = entry.lastAftertouch || 0.0;
        // vb[attrOfs + a2ofs + 7] = entry.newAftertouch || 0.0;

        if (passNr > 0) {
          const tli_in = entry.runBuffers[passNr - 1];
          vb[attrOfs + a3ofs + 0] = tli_in.start;
          vb[attrOfs + a3ofs + 1] = tli_in.count;
          vb[attrOfs + a3ofs + 2] = tli_in.current;
        }
        vb[attrOfs + a3ofs + 3] = -oIX;//tli_out.backBufferIx;

        attrOfs += 8 + 4 + 4;
      }
    }

    // this.vertPullBuffer = gl.updateOrCreateFloatArray(this.vertPullBuffer, vb, attrOfs);
    this.vertexPullTexture = gl.createOrUpdateFloat32TextureBuffer(
      vb,
      this.vertexPullTexture, 0, attrOfs);

    let shader;
    if (shaderName === mixdownShader) {
      // TODO: optimize by doing 1st as write and rest with blend
      // If there is more then 1 track to mixdown, zero output 1st
      if (attrOfs>8) {
        gl.disable(gl.BLEND);
        shader = this.zeroShader;
        gl.useProgram(shader);

        if (shader.u.vertexPullTexture) {
          gl.activeTexture(gl.TEXTURE5);
          gl.bindTexture(gl.TEXTURE_2D, this.vertexPullTexture.texture);
          gl.uniform1i(shader.u.vertexPullTexture, 5);
        }

        gl.drawArrays(gl.LINES, 0, 2); // this.bufferHeight * 2);

        // Let blend mix the tracks together
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.enable(gl.BLEND);
      } else {
        // Only one just overwrite target
        gl.disable(gl.BLEND);
        // gl.enable(gl.BLEND);
        // gl.blendFunc(gl.ONE, gl.ONE);
      }
      shader = this.mixDownShader;
    } else {
      gl.disable(gl.BLEND);
      if (isEffect) {
        shader = this.shaders.getEffectSource(shaderName).program;
      } else {
        shader = this.shaders.getInputSource(shaderName).program;
      }
    }

    gl.useProgram(shader);

    shader.u.startTime?.set(this.synthTime);
    shader.u.processCount?.set(this.processCount);

    // All these tracks should belong to the same channel target for this to work
    if (channelControl) {
      this.loadChanelControls(channelControl);
      if (shader.u.controlTexture) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, channelControl.texInfo.texture);
        gl.uniform1i(shader.u.controlTexture, 2);
        gl.activeTexture(gl.TEXTURE0);
      }
    }

    if (shader.u.backBufferIn) {
      gl.activeTexture(gl.TEXTURE10);
      gl.bindTexture(gl.TEXTURE_2D, this.inputBackTexture);
      gl.uniform1i(shader.u.backBufferIn, 10);
      gl.activeTexture(gl.TEXTURE0);
      backBufferLines = new Array(tracks.length);
      for (let ix = 0; ix < tracks.length; ix++) {
        const tli_out = tracks[ix].entry.runBuffers[passNr];
        let backBufferIx = tli_out.backBufferIx;
        if (backBufferIx === -1) {
          backBufferIx = (this.currentBackBufferIx++ % this.bufferHeight);
          tli_out.backBufferIx = backBufferIx;
          console.log('New backBufferIx: ', backBufferIx);
        }
        // TODO: this can clash if another is bufferHeight further, we need a backbuffer administration
        backBufferLines[ix] = { fromIx: tli_out.current % this.bufferHeight, backBufferIx };
      }

      gl.drawBuffers([
        gl.COLOR_ATTACHMENT0,
        gl.COLOR_ATTACHMENT1
      ]);
    } else {
      gl.drawBuffers([
        gl.COLOR_ATTACHMENT0
      ]);
    }

    if (streamBuffer && streamBuffer.textureInfo.texture) {
      streamBuffer.update();
      shader.u.streamBlocks?.set(streamBuffer.streamBlocks);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, streamBuffer.textureInfo.texture);
      gl.uniform1i(shader.u.inputTexture, 4);
    }

    if (shader.u.sampleTextures) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.sampleTextures[(passNr + 1) & 0x01].texture);
      gl.uniform1i(shader.u.sampleTextures, 0);
    }

    // Enable the attributes for the vertex shader and give it our track line coordinates
    if (shader.u.vertexPullTexture) {
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, this.vertexPullTexture.texture);
      gl.uniform1i(shader.u.vertexPullTexture, 5);
    }

    gl.drawArrays(gl.LINES, 0, attrOfs / 8);
    if (attrOfs > this.maxAttrOfs) {
      this.maxAttrOfs = attrOfs;
      console.log('maxAttr: ', this.maxAttrOfs);
    }

    if (backBufferLines) {
      this.updateBackBufferLines(backBufferLines);
    }
  }

  /** @param {{ entry: SynthNote, shader:string, isEffect:boolean }[]} tracks */
  calculateShader(tracks, passNr) {
    const gl = this.gl;

    const a1 = this.attributeLineBuffer;
    const a2 = this.attributeLineBuffer2;
    const a3 = this.attributeLineBuffer3;

    let channelControl = null

    // Convert track data to attribute data for shader
    let attrOfs = 0;
    let backBufferLines = undefined;

    const shaderName = tracks[0].shader;
    const isEffect = tracks[0].isEffect;
    // Streambuffer comes from the 1st entry, this should al be the same shader and streambuffer
    // TODO: Make sure that calculateShader get called per streambuffer instance
    const streamBuffer = tracks[0].entry.mixer.streamBuffer;

    for (let trackIX = 0; trackIX < tracks.length; trackIX++) {
      let entry = tracks[trackIX].entry;
      const tli_out = entry.runBuffers[passNr];
      // No buffer allocated, can't do anything
      if (tli_out.start === -1) {
        continue;
      }

      let trackLineIx = tli_out.current % this.bufferHeight;
      let lineY = -1.0 + ((trackLineIx + 0.5) / this.bufferHeight) * 2.0;
      const controlTime = this.synthTime;// + this.bufferTime * 0.5;
      // TODO: There is only 1 channel here so we can calculatr this once
      let pitchRange = entry.channelControl.getControlAtTime(controlTime, otherControls.pitchRange, 2.0) || 2.0;
      let pitch = entry.channelControl.getControlAtTime(controlTime, otherControls.pitch, 0.0) || 0.0;
      let playDirection = entry.getPlayDirection(controlTime);

      if (streamBuffer) {
        if (entry.streamNr < 0) {
          entry.streamNr = streamBuffer.getStreamNr(entry.note);
        }
        streamBuffer.fill(entry, this.synthTime);
        // console.log('Volume: ',entry.channelControl.getControlAtTime(controlTime , 7, 0.0));
      }
      for (let oIX = 0; oIX < tli_out.outputCount; oIX++) {
        // TODO this now works because of grouping per channel
        channelControl = entry.channelControl;
        let outputLineIx = tli_out.getCurrentOutput(oIX) % this.bufferHeight;

        let lineY2 = -1.0 + ((outputLineIx + 0.5) / this.bufferHeight) * 2.0;
        a1[attrOfs + 0] = this.synthTime - entry.time;
        a1[attrOfs + 1] = lineY2
        a1[attrOfs + 3] = entry.releaseTime;

        a1[attrOfs + 4] = this.synthTime - entry.time + this.bufferTime;
        a1[attrOfs + 5] = lineY2;

        // Only apply time stretching on pass 0 for pitchbends on notes
        if (passNr !== 0 || oIX !== 0) {
          a1[attrOfs + 2] = this.synthTime - entry.time;
          a1[attrOfs + 6] = this.synthTime - entry.time   + this.bufferTime;
        } else {
          a1[attrOfs + 2] = this.synthTime - entry.phaseTime + entry.audioOffset;
          if (streamBuffer) {
            // Substract from the phaseTime to get more accurate samples
            a1[attrOfs + 2] = a1[attrOfs + 2] % (streamBuffer.streamFloatSize / this.sampleRate);
            // console.log(vb[attrOfs + 2]);
          }

          // Calculation for pitch by timeshift, if we change the frequency in
          // the shader we would need phase corrections, by stretching time
          // we avoid this because the shader can just repeat it's stateless
          // cycle. All intruments get a working pitchbend this way so it seemed
          // like the best option dispite it being kind off a hack
          // Calculate the frequency ratio of the normal and bend note
          // let frequencyRatio = Math.pow(2.0, (entry.note + pitchRange * pitch) / 12.0)
          //                    / Math.pow(2.0, entry.note / 12.0); // note didn't matter so removed for constant
          let frequencyRatio = Math.pow(2.0, (12.0 + pitchRange * pitch) / 12.0) / 2.0;
          // removed constant value / Math.pow(2.0, 12.0 / 12.0);
          // Get the difference as a fraction of the total time
          let timeShift = this.bufferTime * (1.0 - frequencyRatio);
          timeShift += (this.bufferTime - this.bufferTime * playDirection);
          let bufferLengthInTime = this.bufferTime - timeShift

          a1[attrOfs + 6] = a1[attrOfs + 2] + bufferLengthInTime;

          // if (playDirection < 0.0) {
          //   let correction = bufferLengthInTime / this.bufferWidth * 1.0;
          //   a1[attrOfs + 6] -= correction;
          //   a1[attrOfs + 2] += correction;
          // }

          // And change the track startTime
          entry.phaseTime += timeShift;
        }
        a1[attrOfs + 7] = entry.releaseTime;

        // Parameters that change per line so they can't be done in uniforms
        a2[attrOfs + 0] = a2[attrOfs + 4] = (!!streamBuffer) ? entry.streamNr : entry.note;
        a2[attrOfs + 1] = a2[attrOfs + 5] = entry.velocity;

        entry.updateNoteControls && entry.updateNoteControls(this.synthTime);
        a2[attrOfs + 2] = entry.lastReleaseVelocity || 0.0;
        a2[attrOfs + 6] = entry.newReleaseVelocity || 0.0;
        a2[attrOfs + 3] = entry.lastAftertouch || 0.0;
        a2[attrOfs + 7] = entry.newAftertouch || 0.0;

        if (passNr > 0) {
          const tli_in = entry.runBuffers[passNr - 1];
          a3[attrOfs + 0] = a3[attrOfs + 4] = tli_in.start;
          a3[attrOfs + 1] = a3[attrOfs + 5] = tli_in.count;
          a3[attrOfs + 2] = a3[attrOfs + 6] = tli_in.current;
        }
        a3[attrOfs + 3] = a3[attrOfs + 7] = -oIX;//tli_out.backBufferIx;

        // Sanity check here so it crashes where it should
        for (let jx = 0; jx < 8; jx++) {
          if (!isFinite(a1[attrOfs + jx])) debugger;
          if (!isFinite(a2[attrOfs + jx])) debugger;
        }

        attrOfs += 8;
      }
    }

    this.attrBuffer = gl.updateOrCreateFloatArray(this.attrBuffer, a1, attrOfs);
    this.attrBuffer2 = gl.updateOrCreateFloatArray(this.attrBuffer2, a2, attrOfs);
    this.attrBuffer3 = gl.updateOrCreateFloatArray(this.attrBuffer3, a3, attrOfs);

    let shader;
    if (shaderName === mixdownShader) {
      // TODO: optimize by doing 1st as write and rest with blend
      // If there is more then 1 track to mixdown, zero output 1st
      if (attrOfs>8) {
        gl.disable(gl.BLEND);
        shader = this.zeroShader;
        gl.useProgram(shader);

        shader.a.vertexPosition.en();
        shader.a.vertexPosition.set(this.attrBuffer, 4);

        gl.drawArrays(gl.LINES, 0, 2); // this.bufferHeight * 2);

        shader.a.vertexPosition.dis();

        // Let blend mix the tracks together
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.enable(gl.BLEND);
      } else {
        // Only one just overwrite target
        gl.disable(gl.BLEND);
        // gl.enable(gl.BLEND);
        // gl.blendFunc(gl.ONE, gl.ONE);
      }
      shader = this.mixDownShader;
    } else {
      gl.disable(gl.BLEND);
      if (isEffect) {
        shader = this.shaders.getEffectSource(shaderName).program;
      } else {
        shader = this.shaders.getInputSource(shaderName).program;
      }
    }

    gl.useProgram(shader);

    shader.u.startTime?.set(this.synthTime);
    shader.u.processCount?.set(this.processCount);

    // All these tracks should belong to the same channel target for this to work
    if (channelControl) {
      this.loadChanelControls(channelControl);
      if (shader.u.controlTexture) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, channelControl.texInfo.texture);
        gl.uniform1i(shader.u.controlTexture, 2);
        gl.activeTexture(gl.TEXTURE0);
      }
    }

    if (shader.u.backBufferIn) {
      gl.activeTexture(gl.TEXTURE10);
      gl.bindTexture(gl.TEXTURE_2D, this.inputBackTexture);
      gl.uniform1i(shader.u.backBufferIn, 10);
      gl.activeTexture(gl.TEXTURE0);
      backBufferLines = new Array(tracks.length);
      for (let ix = 0; ix < tracks.length; ix++) {
        const tli_out = tracks[ix].entry.runBuffers[passNr];
        let backBufferIx = tli_out.backBufferIx;
        if (backBufferIx === -1) {
          backBufferIx = (this.currentBackBufferIx++ % this.bufferHeight);
          tli_out.backBufferIx = backBufferIx;
          console.log('New backBufferIx: ', backBufferIx);
        }
        // TODO: this can clash if another is bufferHeight further, we need a backbuffer administration
        backBufferLines[ix] = { fromIx: tli_out.current % this.bufferHeight, backBufferIx };
      }

      gl.drawBuffers([
        gl.COLOR_ATTACHMENT0,
        gl.COLOR_ATTACHMENT1
      ]);
    } else {
      gl.drawBuffers([
        gl.COLOR_ATTACHMENT0
      ]);
    }

    if (streamBuffer && streamBuffer.textureInfo.texture) {
      streamBuffer.update();
      shader.u.streamBlocks?.set(streamBuffer.streamBlocks);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, streamBuffer.textureInfo.texture);
      gl.uniform1i(shader.u.inputTexture, 4);
      gl.activeTexture(gl.TEXTURE0);
    }

    if (shader.u.sampleTextures) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.sampleTextures[(passNr + 1) & 0x01].texture);
      gl.uniform1i(shader.u.sampleTextures, 0);
    }

    // Enable the attributes for the vertex shader and give it our track line coordinates
    shader.a.vertexPosition.en();
    shader.a.vertexPosition.set(this.attrBuffer, 4);
    if (shader.a.attributes2) {
      shader.a.attributes2.en();
      shader.a.attributes2.set(this.attrBuffer2, 4);
    }
    if (shader.a.attributes3) {
      shader.a.attributes3.en();
      shader.a.attributes3.set(this.attrBuffer3, 4);
    }

    gl.drawArrays(gl.LINES, 0, attrOfs / 4);
    if (attrOfs > this.maxAttrOfs) {
      this.maxAttrOfs = attrOfs;
      console.log('maxAttr: ', this.maxAttrOfs);
    }

    shader.a.attributes3?.dis();
    shader.a.attributes2?.dis();
    shader.a.vertexPosition?.dis();

    if (backBufferLines) {
      this.updateBackBufferLines(backBufferLines);
    }
  }

  updateBackBufferLines(backBufferLines) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.inputBackFBO);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.outputBackFBO);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    for (const bbl of backBufferLines) {
      // console.log(bbl);
      gl.blitFramebuffer(0,
                         bbl.fromIx,
                         this.bufferWidth,
                         bbl.fromIx+1,
                         0,
                         bbl.backBufferIx,
                         this.bufferWidth,
                         bbl.backBufferIx+1,
                         gl.COLOR_BUFFER_BIT,
                         gl.NEAREST);
    }
  }

  // The advantage of a separate output buffer is that it can read from both sample buffers
  // We could change readpixels to just read the mixed down output from the samplebuffer if we mixed down
  // to one line, but that would not svae a lot. We can als use the output buffer to collect
  // all output in one place and use it for rmsand frequency info as well
  /**
   * @param {SynthNote[]} tracks
   * @param {number} currentOutputBuffer
   */
  mixdownToOutput(tracks, currentOutputBuffer) {
    const gl = this.gl;

    gl.viewport(0, 0, this.bufferWidth, this.outputBufferHeight);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outputTexture.buffers[currentOutputBuffer]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (tracks.length === 0) {
      return;
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    const a1 = this.attributeLineBuffer;

    // Convert track data to attribute data for shader
    let attrOfs = 0;

    for (let trackIX = 0; trackIX < tracks.length; trackIX++) {
      let entry = tracks[trackIX];

      let tli = entry.runBuffers[entry.runBuffers.length-1];
      this.lastOutputTLI = tli;

      a1[attrOfs + 0] = -1.0;
      a1[attrOfs + 4] = 1.0;

      // a1[attrOfs + 1] = a1[attrOfs + 5] = ~~(tli.current / this.bufferHeight);
      // a1[attrOfs + 2] = a1[attrOfs + 6] = ~~(tli.current % this.bufferHeight);
      a1[attrOfs + 1] = a1[attrOfs + 5] = -1.0 + 2.0 * 0.5 / this.outputBufferHeight;
      a1[attrOfs + 2] = a1[attrOfs + 6] = ~~tli.current;
      a1[attrOfs + 3] = a1[attrOfs + 7] = ~~(tli.passNr % 2);
      attrOfs += 8;
    }

    const shader = this.copyLineShader;
    gl.useProgram(shader);

    this.attrBuffer = gl.updateOrCreateFloatArray(this.attrBuffer, a1, attrOfs);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.sampleTextures[0].texture);
    gl.uniform1i(shader.u.sampleTextures0, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.sampleTextures[1].texture);
    gl.uniform1i(shader.u.sampleTextures1, 1);

    shader.u.processCount && shader.u.processCount.set(this.processCount);

    shader.a.vertexPosition.en();
    shader.a.vertexPosition.set(this.attrBuffer, 4);

    gl.drawArrays(gl.LINES, 0, attrOfs / 4);
    if (attrOfs > this.maxAttrOfs) {
      this.maxAttrOfs = attrOfs;
      console.log('maxAttr2: ', this.maxAttrOfs);
    }

    shader.a.vertexPosition.dis();
  }

  /**
   * @param {TrackLineInfo[]} lineInfos
   * @param {number} currentOutputBuffer
   */
  copyDataToOutput(lineInfos,currentOutputBuffer) {
    const gl = this.gl;

    gl.viewport(0, 0, this.bufferWidth, this.outputBufferHeight);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outputTexture.buffers[currentOutputBuffer]);
    // Clearing is done in mixdownToOutput
    // gl.clear(gl.COLOR_BUFFER_BIT);

    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);

    const a1 = this.attributeLineBuffer;

    // Convert track data to attribute data for shader
    let attrOfs = 0;

    for (let ix = 0; ix < lineInfos.length; ix++) {

      let tli = lineInfos[ix];
      this.lastOutputTLI = tli;

      for (let outIx = 0; outIx < tli.outputCount; outIx++) {
        a1[attrOfs + 0] = -1.0;
        a1[attrOfs + 4] = 1.0;

        a1[attrOfs + 1] = a1[attrOfs + 5] = -1.0 + 2.0 * (tli.exportOutputNr + outIx + 1.5) / this.outputBufferHeight;
        a1[attrOfs + 2] = a1[attrOfs + 6] = ~~tli.getCurrentOutput(outIx);
        a1[attrOfs + 3] = a1[attrOfs + 7] = ~~(tli.passNr % 2);
        attrOfs += 8;
      }
    }

    const shader = this.copyLineShader;
    gl.useProgram(shader);

    this.attrBuffer = gl.updateOrCreateFloatArray(this.attrBuffer, a1, attrOfs);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.sampleTextures[0].texture);
    gl.uniform1i(shader.u.sampleTextures0, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.sampleTextures[1].texture);
    gl.uniform1i(shader.u.sampleTextures1, 1);

    shader.u.processCount && shader.u.processCount.set(this.processCount);

    shader.a.vertexPosition.en();
    shader.a.vertexPosition.set(this.attrBuffer, 4);

    gl.drawArrays(gl.LINES, 0, attrOfs / 4);
    if (attrOfs > this.maxAttrOfs) {
      this.maxAttrOfs = attrOfs;
      console.log('maxAttr3: ', this.maxAttrOfs);
    }

    shader.a.vertexPosition.dis();
  }

  /** @param {SynthNote[]} tracks */
  calculateVolume(tracks) {
    const gl = this.gl;

    if (this.recordAnalyze) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.recordAnalyzeBuffer.fbo);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.rmsAvgBuffer.fbo);
    }
    gl.drawBuffers([
      gl.COLOR_ATTACHMENT0,
      gl.COLOR_ATTACHMENT1
    ]);

    if (this.recordAnalyze) {
      gl.viewport(0, 0, this.bufferWidth, this.recordAnalyzeHeight);
    } else {
      gl.viewport(0, 0, this.bufferWidth, this.bufferHeight);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    if (tracks.length === 0) {
      return;
    }
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);
    // WebGL2 API is missing the version per buffer :(
    // gl.blendEquationi(0,gl.MAX);
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.MAX);

    const a1 = this.rmsAvgEngMaxAttributeBuffer;
    // Convert track data to attribute data for shader
    let attrOfs = 0;
    for (let trackIX = 0; trackIX < tracks.length; trackIX++) {
      let entry = tracks[trackIX];

      // for (let tli of entry.runBuffers) {
      if (this.recordAnalyze) {
        if (entry.recordStartIndex === -1) {
          continue;
        }
        // Alway analyze 0, could add options for this later
        let tli = entry.runBuffers[this.recordAnalyzeStep];
        a1[attrOfs + 0] = tli.passNr;
        a1[attrOfs + 1] = tli.current;
        a1[attrOfs + 2] = entry.recordStartIndex;
        a1[attrOfs + 3] = this.recordAnalyzeMultiplier;
        if ((this.synthTime - entry.time) >= -0.00001) {
          entry.recordStartIndex += this.recordAnalyzeMultiplier;
        }
        // attrOfs += 4;
        // a1[attrOfs + 0] = tli.passNr;
        // a1[attrOfs + 1] = tli.current;
        // a1[attrOfs + 2] = entry.recordStartIndex++
        // a1[attrOfs + 3] = 1;
      } else {
        let tli = entry.runBuffers[entry.runBuffers.length-1];
        a1[attrOfs + 0] = tli.passNr;
        a1[attrOfs + 1] = tli.current;
        a1[attrOfs + 2] = tli.current + (tli.passNr % 2) * this.bufferHeight * this.bufferCount / 2;
        // int bufferIx = lineIx + texNr * bufferHeight * bufferCount;
        a1[attrOfs + 3] = 1;
      }
      attrOfs += 4;
    }

    const shader = this.rmsAvgEngMaxValueShader;
    gl.useProgram(shader);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.sampleTextures[0].texture);
    gl.uniform1i(shader.u.sampleTextures0, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.sampleTextures[1].texture);
    gl.uniform1i(shader.u.sampleTextures1, 1);

    this.volumeInfo = gl.createOrUpdateFloat32TextureBuffer(this.rmsAvgEngMaxAttributeBuffer, this.volumeInfo);
    if (shader.u.tliDataTexture) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.volumeInfo.texture);
      gl.uniform1i(shader.u.tliDataTexture, 2);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.drawArrays(gl.POINTS, 0, attrOfs / 4 * this.bufferWidth);//tracks.length * this.bufferWidth);

    // Reset stuff only used here
    gl.blendEquation(gl.FUNC_ADD);
  }

  calculateSamples() {
    const gl = this.gl;

    /** @type {TrackLineInfo[]} */
    let outputInfos = [];
    let start = performance.now();
    let maxPassNr = 0;
    let currentEntries = this.playData.getCurrentEntries(this.synthTime, this.bufferTime);
    // Make sure all the buffers are allocated and get the right pass number
    // and get the number of passes we need
    // CaVEATS:
    // If one note entry uses more effects but ends in the same mixer, it would give problems in
    // the odd/even sceme for mixdown because we use this to swap target and source on each pass
    // But since i'm building it with pre and post mixers and after that possible channel mixer
    // They should all have the same length, otherwize an extra copy would be needed to sync odd/even
    for (let entry of currentEntries) {
      let passNr = 0;
      /** @type {SynthMixer} */ // @ts-ignore
      let traceEntry = entry;
      while (traceEntry) {
        let nextEntry = traceEntry?.mixer;
        traceEntry.synth = this;
        traceEntry.runHandled = false;
        passNr = traceEntry.updateBuffers(this, nextEntry, passNr);
        maxPassNr = Math.max(maxPassNr, passNr);
        traceEntry = nextEntry;
      }
    }
    let calculatedTracks = [];
    for (let entry of currentEntries) {
      /** @type {SynthBaseEntry} */
      let traceEntry = entry;
      entry.runBuffers = [];
      entry.runShaders = [];
      while (traceEntry && !traceEntry.runHandled) {
        let nextEntry = traceEntry?.mixer;
        if (traceEntry === this.playData.output) {
          calculatedTracks.push(entry);
          break;
        }
        traceEntry.runHandled = true;
        if (traceEntry.outputs?.length) {
          for (let ix = 0; ix < traceEntry.outputs.length; ix++) {
            let od = traceEntry.outputs[ix];
            let tli = traceEntry.buffers[od.bufferNr];
            tli.exportOutputNr = od.outputNr;
            outputInfos.push(tli)
          }
        }
        // TODO find out if this is efficient or not
        entry.runBuffers = [...entry.runBuffers, ...traceEntry.buffers];
        if (nextEntry) {
          entry.runShaders = [...entry.runShaders, nextEntry.inputShaderName || mixdownShader, ...nextEntry.effects.map(x => x.shaderName)];

          // In record mode just skipt the mixdown and postmixers
          if (entry.recordStartIndex !== -1) {
            calculatedTracks.push(entry);
            break;
          }

          if (nextEntry.runHandled) {
            entry.runBuffers.push(nextEntry.buffers[0]);
            entry.runShaders.push(mixdownShader);
          }
        }
        traceEntry = nextEntry;
      }
    }

    gl.viewport(0, 0, this.bufferWidth, this.bufferHeight);
    gl.disable(gl.BLEND);
    let shaderPasses = 0;
    let shaderLines = 0;
    if (currentEntries.length && !this.stopOutput) {
      // let passNr = 0;
      // Group per target bufferNr and shader for efficient handling
      for (let passNr = 0; passNr < maxPassNr; passNr++) {
        let groups = {}
        // Group shaders for this pass
        for (let entry of currentEntries) {
          if (passNr >= entry.runShaders.length) {
            continue;
          }
          let buffer = entry.runBuffers[passNr];
          let shader = entry.runShaders[passNr];
          // Since we can only target one framebuffer (which is one texture in the texture array) we make this our main group
          let bufferNr = Math.floor(buffer.current / this.bufferHeight);
          // let shader = (passNr===0) ? entry.data.program : mixer.effects[passNr-1].effectName;
          let bufferGroup = groups[bufferNr];
          if (!bufferGroup) {
            bufferGroup = groups[bufferNr] = {};
          }

          let isEffect = (passNr !== 0);
          let groupKey = shader + '_' + entry.channel;
          // Multiple target mixers in same channel need to be mixed seperately
          if (shader === mixdownShader) {
            groupKey = '#md_' + buffer.current;
          }
          let shaderGroup = bufferGroup[groupKey];
          if (!shaderGroup) {
            shaderGroup = bufferGroup[groupKey] = [];
          }
          shaderGroup.push({ entry, shader, isEffect });
        }

        // Run shaders for this pass
        for (let bufferGroup of Object.entries(groups)) {
          let bufferNr = bufferGroup[0];
          const buffers = this.sampleTextures[passNr & 0x01].buffers;
          gl.bindFramebuffer(gl.FRAMEBUFFER, buffers[bufferNr]);
          for (let shaderGroup of Object.entries(bufferGroup[1])) {
            let tracks = shaderGroup[1];
            shaderLines += tracks.length;
            shaderPasses++;
            if (vertextPull) {
              this.calculateShader_VertexPull(tracks, passNr);
            } else {
              this.calculateShader(tracks, passNr);
            }
          }
        }
      }
    }

    let currentOutputBuffer = this.processCount % outputBufferCycleCount;
    this.mixdownToOutput(calculatedTracks, currentOutputBuffer);
    this.calculateVolume(calculatedTracks);
    if (outputInfos.length > 0) {
      this.copyDataToOutput(outputInfos, currentOutputBuffer);
    }

    shaderPasses += 2;
    shaderLines += calculatedTracks.length * 2;
    let stop = performance.now();
    if ((this.processCount % 64) === 0) {
      // console.log('entry count:  ', currentEntries.length);
      // console.log('calc time:    ', (stop-start).toFixed(2),'ms')
      // console.log('shader lines: ', shaderLines);
      // console.log('calc count:   ', shaderPasses);
      // console.log('pass count:   ', maxPassNr);
      // console.log('output count: ', calculatedTracks.length);
    }

    this.totalEntryTime += stop - start;

    this.webGLSync[currentOutputBuffer] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this.samplesCalculated = true;
    this.synthTime += this.bufferTime;

    this.lastEntryCount = currentEntries.length;
    return this.processCount++;
  }

  checkSamplesReady(processCount) {
    let currentOutputBuffer = processCount % outputBufferCycleCount;
    let sync = this.webGLSync[currentOutputBuffer]
    if (!sync) {
      return true;
    }
    this.gl.finish();
    let state = this.gl.clientWaitSync(sync, 0, 0); // THis errprs with more then 0 STUPID ERROR this.gl.MAX_CLIENT_WAIT_TIMEOUT_WEBGL-1)
    // let state = this.gl.clientWaitSync(this.webGLSync, 0, this.gl.MAX_CLIENT_WAIT_TIMEOUT_WEBGL-1)
    // console.log('state: ', state);
    // 37146 ALREADY ALREADY_SIGNALED
    // 37147 TIMEOUT_EXPIRED
    // 37148 CONDITION_SATISFIED
    // 37149 WAIT_FAILED

    return (state !== this.gl.TIMEOUT_EXPIRED);

    // return (state === this.gl.CONDITION_SATISFIED) ||
    //    (state === this.gl.ALREADY_SIGNALED);
  }

  /**
   * @param {number} processCount
   * @param {AudioOutputSharedData} sharedData
   * @returns
   */
  getCalculatedSamples(processCount, sharedData = null) {
    this.samplesCalculated = false;
    const gl = this.gl;
    let bufferData = this.audioOutputBuffer;
    if (sharedData) {
      bufferData = sharedData.getNextBlockView();
    }

    const currentOutputBuffer = processCount % outputBufferCycleCount;
    //

    // if (!this.webGLSync) {
    //   if (!sharedData) {
    //     bufferData.fill(0);
    //   }
    //   return bufferData;
    // }

    let sync = this.webGLSync[currentOutputBuffer];
    if (sync) {
      gl.clientWaitSync(sync, 0, 0);
      this.webGLSync[currentOutputBuffer] = null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outputTexture.buffers[currentOutputBuffer]);
    // Thanks for https://stackoverflow.com/questions/45571488/webgl-2-readpixels-on-framebuffers-with-float-textures
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    let start = performance.now();
    gl.readPixels(
      0,
      0,
      this.bufferWidth,
      this.outputBufferHeight,
      force4Components ? gl.RGBA : this.glFormat,
      gl.FLOAT,
      this.readSampleBuffer
    );
    let stop = performance.now();
    this.averageRead = (stop - start) * 0.1 + 0.9 * this.averageRead;
    // if ((this.processCount % 60)===0) {
    //   console.log(this.averageRead);
    // }

    // gl.bindFramebuffer(gl.FRAMEBUFFER, this.inputBackFBO);
    // gl.readBuffer(gl.COLOR_ATTACHMENT0);
    // gl.readPixels(
    //   0,
    //   this.currentBackBufferIx-1,
    //   this.bufferWidth,
    //   1,
    //   gl.RGBA,
    //   gl.FLOAT,
    //   this.backBufferTestBuffer
    // );
    // gl.readBuffer(gl.COLOR_ATTACHMENT0);

    // if ((this.processCount % 64)===0) {
    //   for (let ix = 0; ix < this.backBufferTestBuffer.length; ix++) {
    //     const val = this.backBufferTestBuffer[ix];
    //     if (val !== 0) {
    //       console.log(ix,':',val);
    //       break;
    //     }
    //   }
    // }
    // if (this.recordAnalyzeBuffer) {
    //   gl.bindFramebuffer(gl.FRAMEBUFFER, this.recordAnalyzeBuffer.fbo);
    //   let start = performance.now();
    //   gl.readPixels(
    //     0,
    //     0,
    //     this.bufferWidth,
    //     2,
    //     gl.RGBA,
    //     gl.FLOAT,
    //     this.readRmsAvgEngMaxBuffer
    //   );
    //   let stop = performance.now();
    //   this.averageRead = (stop-start) * 0.1 + 0.9 * this.averageRead;
    //   if ((this.processCount % 60)===0) {
    //     console.log(this.averageRead);
    //   }
    // }

    let sourceIx = this.floatWidthGPU * 0;
    let destIx = 0;
    for (let ix = 0; ix < this.floatWidthGPU / (force4Components ? 4.0 : 2.0); ix++) {
      bufferData[destIx++] = this.readSampleBuffer[sourceIx++];
      bufferData[destIx++] = this.readSampleBuffer[sourceIx++];
      // FIX FOR MAC,LINUX & ANDROID, readpixels only works with 4 values and i only need 2 for stereo :(
      sourceIx += ~~force4Components
      sourceIx += ~~force4Components
    }

    // Automatic volume correction
    let maxLevel = 0.0;
    for (let ix = 0; ix < this.floatWidth; ix++) {
      maxLevel = Math.max(maxLevel, Math.abs(bufferData[ix]));
      if (!isFinite(bufferData[ix])) {
        if (isNaN(bufferData[ix])) {
          this.nanCount++;
        } else {
          this.infiniteCount++;
        }
        bufferData[ix] = 0.0;
      }
    }
    this.maxLevel = maxLevel;

    let correctiveDelta = 0.0;
    // console.log(maxLevel)
    if (maxLevel > 0.0001) {
      // TODO: setable db levels
      let newValue = Math.min(Math.max((0.9 / maxLevel), 0.2), 5.0);
      let oldValue = this.correctiveVolume;
      if (newValue < this.correctiveVolume) {
        this.correctiveVolume =
          0.7 * this.correctiveVolume +
          0.3 * newValue;
      } else {
        this.correctiveVolume =
          0.998 * this.correctiveVolume +
          0.002 * newValue;
      }
      correctiveDelta = (oldValue - this.correctiveVolume) / this.floatWidth;
      // console.log(this.maxLevel, this.correctiveVolume, this.maxLevel * this.correctiveVolume);
    }
    let clamping = false;
    let maxValue = 0.0;
    let clampCount = 0;
    if (this.automaticVolume) {
      // this.correctiveVolume = 0.5;
      for (let ix = 0; ix < this.floatWidth; ix++) {
        bufferData[ix] *= this.correctiveVolume - correctiveDelta * (this.floatWidth - ix);
        if (Math.abs(bufferData[ix]) > 0.999999) {
          bufferData[ix] = Math.max(-0.999999, Math.min(0.999999, bufferData[ix]));
          clamping = true;
        }
      }
    } else {
      for (let ix = 0; ix < this.floatWidth; ix++) {
        const bd = bufferData[ix] * this.outputMultiplier;
        const bda = Math.abs(bd);
        if (Math.abs(bd) > 1.0005) {
          clamping = true;
          clampCount++;
        }
        maxValue = Math.max(maxValue,bda);
        bufferData[ix] = Math.max(-1.0, Math.min(1.0, bd));
      }
    }

    if (clamping) {
      console.log('volume to loud, buffer clamped!, ', maxValue, clampCount);
    }

    this.lastMaxValue = Math.max(this.lastMaxValue, maxValue);
    if (processCount % 10 === 0) {
      // console.log('maxValue: ', this.lastMaxValue);
      this.lastMaxValue = maxValue;
    }

    if (sharedData) {
      sharedData.nextWriteBlockNr++;
    }

    return bufferData;
  }
}

export default WebGLSynth;
