// Copyright by André van Kammen
// Licensed under CC BY-NC-SA 
// https://creativecommons.org/licenses/by-nc-sa/4.0/

import getWebGLContext from '../KMN-utils.js/webglutils.js';
import SystemShaders from './webgl-synth-shaders.js';
import SynthPlayData, { ControlHandler, SynthBaseEntry, SynthMixer, SynthNote } from './webgl-synth-data.js';
import { otherControls } from './otherControls.js';
import { StreamBuffer } from './stream-buffer.js';
import { WebGLMemoryManager } from './webgl-memory-manager.js';

// https://stackoverflow.com/questions/53562825/glreadpixels-fails-under-webgl2-in-chrome-on-mac
// Fix needed for Linux Mac & android
// TODO Find out if it's still the case and if only for readPixels we only need to make the output buffer 4 componets
const force4Components = true; // Setting to false doesn't give memory saving in chrome on my GTX1070 not in OpenGL and not in default render settings
// Using OpenGl in chrome ANGLE graphics back-end saves some additional 25% GPU memory but gives more lag when shaders are run for the 1st time
// D3D11on12 behaves the same as OpenGL
// D3D9 DOESN'T work, looks like webgl2 support missing
// D3D11 same memory savings (maybe it was reloading the browser) meory usage still the same with force4Components = true
// Back on default memory is lower again. opening debugger once also increases GPU memory a lot (Dedicated GPU in
const useTexStorage = true
const mixdownShader = '#mixdown';

// Got to 3.5GB of memory usage, more seems to crash webgl in the page
const defaultOptions = {
  sampleRate: 44100,
  bufferWidth: 1024,
  bufferHeight: 1024,
  bufferCount: 16, // Is for source and target so 2 times as big
  channelCount: 2 // Actualy only 2 will work for now because all shaders are stereo
};

const defaultShaderName = 'piano'

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

    this.stopOutput = false;
    this.recordAnalyze = false;

    this.streamBuffer = null;

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

    const formatIndex = this.componentCount - 1;
    // TODO: set all to 4 components
    this.glInternalFormat = gl.RGBA32F;//[gl.R32F, gl.RG32F, gl.RGB32F,gl.RGBA32F][formatIndex];
    this.glFormat = gl.RGBA;//[gl.RED, gl.RG, gl.RGB, gl.RGBA][formatIndex];
    // this.glInternalFormat = [gl.R32F, gl.RG32F, gl.RGB32F,gl.RGBA32F][formatIndex];
    // this.glFormat = [gl.RED, gl.RG, gl.RGB, gl.RGBA][formatIndex];

    this.outputTexture = this.createSampleTextures(1, 1);

    this.sampleTextures = [
      this.createSampleTextures(this.bufferCount),
      this.createSampleTextures(this.bufferCount)
    ];

    // Back buffers for use in fourier transform params injection in next pass
    this.inputBackTexture = this.createBackBufferTexture(this.bufferHeight); // TODO dynamic size?
    this.outputBackTexture = this.createBackBufferTexture(this.bufferHeight); // Needs to be bufferheight size
    this.inputBackFBO = this.createFBOforTexture(this.inputBackTexture);
    this.outputBackFBO = this.createFBOforTexture(this.outputBackTexture);

    this.lineCount = this.bufferHeight * this.bufferCount * 2
    this.rmsAvgEngMaxAttributeBuffer = new Float32Array(this.bufferHeight * this.bufferCount * 2 * 4)
    this.rmsAvgBuffer = this.createRmsAvgEngMaxTextures(this.lineCount / this.bufferWidth)

    this.readRmsAvgEngMaxBuffer = new Float32Array(this.lineCount * 4);
   
    this.volumeInfo = { texture:undefined, size:0 };

    this.zeroShader = this.getProgram(SystemShaders.vertex, SystemShaders.zero);
    this.mixDownShader = this.getProgram(SystemShaders.vertex, SystemShaders.mixdown);
    this.copyLineShader = this.getProgram(SystemShaders.copyLineVertex, SystemShaders.copyLine);
    this.rmsAvgEngMaxValueShader = this.getProgram(SystemShaders.rmsAvgEngMaxVertex, SystemShaders.rmsAvgEngMax);

    this.defaultShaderName = defaultShaderName;
    this.shaderPrograms = {};
    this.effectPrograms = {};

    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    const ext = gl.getExtension('EXT_color_buffer_float');
    if (!ext) {
      alert('need EXT_color_buffer_float');
      return;
    }
    
    this.floatWidth = this.bufferWidth * this.componentCount;
    //set to RGBA, FIX FOR LINUX, MAC & ANDROID;
    this.floatWidthGPU = force4Components ? this.bufferWidth * 4 : this.floatWidth;

    // The buffer for reading the output of the videocard
    this.readSampleBuffer = new Float32Array(this.floatWidthGPU);

    this.backBufferTestBuffer = new Float32Array(this.bufferWidth * 1 * 4),
    // The buffer for output of the synth;
    this.outputBuffer = new Float32Array(this.bufferWidth * this.componentCount);

    // Did we send the data to the videocard?
    this.samplesCalculated = false;

    // Counter which increases for every outputBuffer
    // used for calculating circular buffer positions
    this.processCount = 0;

    // Attribute buffers for sending to videocard
    // TODO size is way to big, needs a maxtracks 
    this.attributeLineBuffer  = new Float32Array(this.bufferHeight * 2 * 4 * this.bufferCount * 2 );
    this.attributeLineBuffer2 = new Float32Array(this.bufferHeight * 2 * 4 * this.bufferCount * 2 );
    this.attributeLineBuffer3 = new Float32Array(this.bufferHeight * 2 * 4 * this.bufferCount * 2 );

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

    this.addBackBufferToSampleFBO(); // 20ms< for 1000 times
  }

  createStreamBuffer() {
    this.streamBuffer = new StreamBuffer(this, this.playData);
    return this.streamBuffer;
  }

  // This is the thing you fill with notes to play
  getPlayData() {
    return this.playData;
  }
  dispose() {
    // TODO
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

//#region "Shader stuff"
// ******************************************
// ****** Shader loading and compiling ******
// ******************************************
  getDefaultDefines () { return `
#define bufferHeight ${~~this.bufferHeight}
#define bufferWidth ${~~this.bufferWidth}
#define bufferCount ${~~(this.bufferCount / 2)}
#define sampleRate ${~~this.sampleRate}
` }

  updateSource(shaderCode) {
    let subShader = '';
    if (shaderCode.indexOf('#include waveform')!==-1) {
      subShader = shaderCode;
    } else if (shaderCode.indexOf('#include formula')!==-1) {
      subShader = 
      `vec2 waveform(float frequency, float phase) {
         return vec2(
           ${shaderCode}
         );
      }`;
    } else if (shaderCode.indexOf('#include shadertoy')!==-1) {
      // TODO: lot of clashing variable names, so maybe dedicated shadertoy version?
      subShader = 
      `${shaderCode}

      vec2 waveform(float frequency, float phase) {
         return mainSound(time);
      }`;
    } else {
      return shaderCode;
    }
    return SystemShaders.waveform.replace('{WaveformFunction}', subShader);
  }

  updateEffectSource(shaderCode) {
    let subShader = '';
    if (shaderCode.indexOf('#include effect')!==-1) {
      subShader = shaderCode;
    } else {
      return shaderCode; 
    }
    if (shaderCode.indexOf('#include effect4')!==-1) {
      return SystemShaders.effect4.replace('{EffectFunction}', subShader);
    } else {
      return SystemShaders.effect.replace('{EffectFunction}', subShader);
    }
  }

  /**
   * Get program with default defines added
   * @param {*} vertexSrc 
   * @param {*} framentSrc 
   */
  getProgram(vertexSrc,framentSrc) {
    return this.gl.getShaderProgram(
      this.getDefaultDefines() + vertexSrc, 
      this.getDefaultDefines() + framentSrc, 2);
  }

  getInputProgram(shaderCode) {
    return this.getProgram(
      SystemShaders.vertex, 
      this.updateSource(shaderCode));
  }

  getEffectProgram(shaderCode) {
    return this.getProgram(
      SystemShaders.vertex, 
      this.updateEffectSource(shaderCode));
  }

  getInputSource(shaderName) {
    let shader = this.shaderPrograms[shaderName];
    if (shader) {
      return shader;
    }
    let shaderCode = this.getSynthShaderCode(shaderName); // SynthShaders[shaderName];
    if (shaderCode) {
      shader = this.getInputProgram(shaderCode);
      this.shaderPrograms[shaderName] = shader;
      return shader;
    }
    if (shaderName ) {
       console.warn('Input shader not found: ',shaderName);
    }
    return null;
  }

  getEffectSource(shaderName) {
    let shader = this.effectPrograms[shaderName];
    if (shader) {
      return shader;
    }
    let shaderCode = this.getEffectShaderCode(shaderName); // EffectShaders[shaderName];
    if (shaderCode) {
      shader = this.getEffectProgram(shaderCode);
      this.effectPrograms[shaderName] = shader;
      return shader;
    }
    if (shaderName ) {
       console.warn('Effect shader not found: ',shaderName);
    }
    return null;
  }

  compileShader (type, name, source, options) {
    if (type==='effect') {
      return this.compileEffect (name, source, options)
    } else {
      return this.compileSynth (name, source, options)
    }
  }

  compileSynth (name, source, options) {
    // return this.webgl.compileShader (source, options)
    const compileInfo = this.gl.getCompileInfo(this.getDefaultDefines() + this.updateSource(source), this.gl.FRAGMENT_SHADER, 2);
    if (compileInfo.compileStatus) {
      this.shaderPrograms[name] = this.getInputProgram(source);
      this.defaultShaderName = name;
      console.info('Synth shader compiled OK');
    } else {
      console.log('Shader error: ',compileInfo);
    }
    return compileInfo
  }

  compileEffect (name, source, options) {
    // return this.webgl.compileShader (source, options)
    const compileInfo = this.gl.getCompileInfo(this.getDefaultDefines() + this.updateEffectSource(source), this.gl.FRAGMENT_SHADER, 2);
    if (compileInfo.compileStatus) {
      this.effectPrograms[name] = this.getEffectProgram(source);
      // this.copyShader = this.gl.getShaderProgram(SystemShaders.vertex, src, 2);
      console.info('Effect shader compiled OK');
    } else {
      console.log('Shader error: ',compileInfo);
    }
    return compileInfo
  }
// #endregion

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

  /** @param {ControlHandler} channelControls */
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
  calculateShader(tracks, passNr) {
    const gl = this.gl;

    const a1 = this.attributeLineBuffer;
    const a2 = this.attributeLineBuffer2;
    const a3 = this.attributeLineBuffer3;

    let channelControl = null

    // Convert track data to attribute data for shader
    let attrOfs = 0;
    let backBufferLines = undefined;

    // TODO: Consider: There can be only streamBuffer for now (it has 128 tracks, should be enough)
    const shaderName = tracks[0].shader;
    const isEffect = tracks[0].isEffect;
    const streamBuffer = shaderName === 'playInput' ? this.streamBuffer : null;

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
      let pitch = entry.channelControl.getControlAtTime(controlTime , otherControls.pitch, 0.0) || 0.0;

      if (streamBuffer) {
        if (entry.trackNr < 0) {
          entry.trackNr = streamBuffer.getTrackNr(entry.note);
          entry.note = entry.trackNr;
          // entry.phaseTime = entry.time;// - entry.audioOffset;
          // console.log('tracknr assigned: ',entry.trackNr);
        }
        streamBuffer.fill(this.synthTime - entry.phaseTime + entry.audioOffset, entry.trackNr);
        // console.log('Volume: ',entry.channelControl.getControlAtTime(controlTime , 7, 0.0));
      }
      for (let oIX = 0; oIX < tli_out.outputCount; oIX++) {
        // TODO this now works because of grouping per channel
        channelControl = entry.channelControl;

        a1[attrOfs + 0] = this.synthTime - entry.time + (oIX * this.bufferTime);
        a1[attrOfs + 1] = lineY;
        a1[attrOfs + 3] = entry.releaseTime;

        a1[attrOfs + 4] = this.synthTime - entry.time + ((oIX + 1) *this.bufferTime);
        a1[attrOfs + 5] = lineY;

        // Only apply time stretching on pass 0 for pitchbends on notes
        if (passNr !== 0) {
          a1[attrOfs + 2] = this.synthTime - entry.time + (oIX * this.bufferTime);
          a1[attrOfs + 6] = this.synthTime - entry.time + ((oIX + 1) *this.bufferTime);
        } else {
          a1[attrOfs + 2] = this.synthTime - entry.phaseTime + entry.audioOffset;
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
          // This line add to output
          a1[attrOfs + 6] = a1[attrOfs + 2] + this.bufferTime - timeShift;

          // a1[attrOfs + 0] = a1[attrOfs + 2];
          // a1[attrOfs + 4] = a1[attrOfs + 6];
            // And change the track startTime 
          entry.phaseTime += timeShift;
        }
        a1[attrOfs + 7] = entry.releaseTime;

        // Parameters that change per line so they can't be done in uniforms
        a2[attrOfs + 0] = a2[attrOfs + 4] = entry.note;
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
        a3[attrOfs + 3] = a3[attrOfs + 7] = tli_out.backBufferIx;

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
    
        // Let blend mix the racks together
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
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
        shader = this.getEffectSource(shaderName);
      } else {
        shader = this.getInputSource(shaderName);
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
        backBufferLines[ix] = { fromIx: tli_out.current % this.bufferHeight ,backBufferIx};
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

  // The only advantage of a separate output buffer is that it can read from both sample buffers
  // We could change readpixels just read the mixed down output from the samplebuffer if we mixed down
  // to one line, but maybe we can collect all output in outputbuffer and use it for the rms info as well
  /** @param {SynthNote[]} tracks */
  mixdownToOutput(tracks) {
    const gl = this.gl;

    gl.viewport(0, 0, this.bufferWidth, 1);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outputTexture.buffers[0]);
    gl.clear(gl.COLOR_BUFFER_BIT);
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

      a1[attrOfs + 1] = a1[attrOfs + 5] = ~~(tli.current / this.bufferHeight);
      a1[attrOfs + 2] = a1[attrOfs + 6] = ~~(tli.current % this.bufferHeight);
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
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
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
        entry.recordStartIndex += this.recordAnalyzeMultiplier;
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
      while (traceEntry && ! traceEntry.runHandled) {
        let nextEntry = traceEntry?.mixer;
        if (traceEntry === this.playData.output) {
          calculatedTracks.push(entry);
          break;
        }
        traceEntry.runHandled = true;
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
            this.calculateShader(tracks, passNr);
          }
        }
      }
    }
    if (!this.recordAnalyze) {
      this.mixdownToOutput(calculatedTracks);
    }
    this.calculateVolume(calculatedTracks);
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

    // TODO: make sync for multiple timeslots so we can work in parralel
    if (this.recordAnalyze) {
      this.webGLSync = null;
    } else {
      this.webGLSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    }
    this.samplesCalculated = true;
    return currentEntries.length > 0;
  }

  checkSamplesReady() {
    if (!this.webGLSync) {
      return false;
    }
    return this.gl.clientWaitSync(this.webGLSync, 0, 0) === this.gl.CONDITION_SATISFIED;
  }

  getCalculatedSamples() {
    this.samplesCalculated = false;
    const gl = this.gl;

    if (!this.webGLSync) {
      return [];
    }
    
    gl.clientWaitSync(this.webGLSync, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outputTexture.buffers[0]);
    // Thanks for https://stackoverflow.com/questions/45571488/webgl-2-readpixels-on-framebuffers-with-float-textures
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    let start = performance.now();
    gl.readPixels(
      0,
      0,
      this.bufferWidth,
      1,
      force4Components ? gl.RGBA : this.glFormat,
      gl.FLOAT,
      this.readSampleBuffer
    );
    let stop = performance.now();
    this.averageRead = (stop-start) * 0.1 + 0.9 * this.averageRead;
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

    const bufferData = this.outputBuffer;
    bufferData.fill(0);

    let sourceIx = 0;
    let destIx = 0;
    for (let ix = 0; ix < this.floatWidthGPU/(force4Components ? 4.0 : 2.0); ix++) {
      bufferData[destIx++] += this.readSampleBuffer[sourceIx++];
      bufferData[destIx++] += this.readSampleBuffer[sourceIx++];
      // FIX FOR MAC,LINUX & ANDROID, readpixels only works with 4 values and i only need 2 for stereo :(
      sourceIx += ~~force4Components
      sourceIx += ~~force4Components
    }

    this.automaticVolume = true;
    if (this.automaticVolume) {
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
      this.maxLevel = maxLevel // * this.correctiveVolume

      // console.log(maxLevel)
      if (maxLevel > 0.001) {
        let newValue = Math.min(0.4, (1.0 / maxLevel));
        if (newValue < this.correctiveVolume) {
          this.correctiveVolume =
            0.999 * this.correctiveVolume +
            0.001 * newValue;
        } else {
          this.correctiveVolume =
            0.99999 * this.correctiveVolume +
            0.00001 * (newValue * 0.25);
        }
      }

      // this.correctiveVolume = 0.5;
      for (let ix = 0; ix < this.floatWidth; ix++) {
        bufferData[ix] *= this.correctiveVolume;
        if (Math.abs(bufferData[ix]) > 0.999999) {
          bufferData[ix] = Math.max(-0.999999, Math.min(0.999999, bufferData[ix]));
          // console.log('volume to loud, buffer clamped!');
        }
      }
    }

    this.synthTime += this.bufferTime;
    this.processCount++;

    return bufferData;
  }
}

export default WebGLSynth;
