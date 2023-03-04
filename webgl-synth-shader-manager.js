import { WebGLProgramExt } from "../KMN-utils.js/webglutils.js";
import { WebGLSynthControls } from "./webgl-synth-controls.js";
import SystemShaders from "./webgl-synth-shaders.js";
import WebGLSynth from "./webgl-synth.js";

export const defaultHistoryTime = 0.001;
export const vertextPull = true;

function getFormulaWaveform(expressionCode) {
  return /*glsl*/`
vec2 waveform(float frequency, float phase) {
  return vec2(
    ${expressionCode}
  );
}`;
}

function getShaderToyWaveform(shaderToyCode) {
  return /*glsl*/`
${shaderToyCode}

vec2 waveform(float frequency, float phase) {
   return mainSound(time);
}`;
}

export class SynthShaderInfo {
  /**
   *
   * @param {SynthShaderManager} owner
   * @param {string} shaderName
   */
  constructor(owner, shaderName) {
    this.owner = owner;
    this.options = {};
    // this.trackLineInfo = new TrackLineInfo();
    this.shaderName = shaderName;
    /** @type {WebGLProgramExt} */
    this._program = null;
    this._shaderBaseCode = '';
    this._shaderFullCode = '';
  }

  udpateShader(source = '') {
    this._shaderBaseCode = source || this.getShaderBaseCode();
    if (!this._shaderBaseCode) {
      console.warn('Input shader not found: ', this.shaderName);
    } else {
      this._shaderFullCode = this.updateShaderCode(this._shaderBaseCode);
    }
    this._program = this.getProgram();
  }

  get program() {
    if (!this._program) {
      this._program = this.getProgram();
    }
    return this._program;
  }

  getShaderBaseCode() {
    return null
  }

  getProgram() {
    return null
  }
  /**
   *
   * @param {string} shaderCode
   * @param {string} paramName
   */
  updateOptionFromSource(shaderCode, paramName) {
    if (shaderCode) {
      let ix = shaderCode.indexOf('#' + paramName);
      if (ix !== -1) {
        let valStr = '';
        ix += paramName.length + 1;
        for (; ix < shaderCode.length; ix++) {
          let c = shaderCode[ix];
          if (c >= '0' && c <= '9' || c === '.' || c === '-') {
            valStr += c;
          } else if (c === '\n' || c === '/') {
            break;
          } else if (valStr !== '') {
            break;
          }
        }
        this.options[paramName] = Number.parseFloat(valStr);
        console.log(paramName, '=', valStr);
      }
    }
  }

  /**
   *
   * @param {string} shaderCode
   */
  updateControlsInSource(shaderCode) {
    let ix = shaderCode.indexOf('#include controls');
    if (ix !== -1) {
      let ix2 = shaderCode.indexOf('\n', ix) + 1;
      return shaderCode.substring(0, ix2) + this.owner.controls.getControlsShaderCode(shaderCode) + shaderCode.substring(ix2);
    }
    return shaderCode;
  }

  updateShaderCode(shaderBaseCode) {
    return shaderBaseCode;
  }
}

export class EffectShaderInfo extends SynthShaderInfo {
  /**
   *
   * @param {SynthShaderManager} owner
   * @param {string} shaderName
   */
  constructor (owner, shaderName) {
    super(owner, shaderName)
    this.options = {
      ...super.options,
      historyTime: defaultHistoryTime,
      outputCount: 1
    };
    this.udpateShader();
  }

  updateEffectSource(shaderCode) {
    if (shaderCode.indexOf('#include effect') !== -1) {
      let subShader = shaderCode;
      if (shaderCode.indexOf('#include effect4') !== -1) {
        shaderCode = SystemShaders.effect4.replace('{EffectFunction}', subShader);
      } else {
        shaderCode = SystemShaders.effect.replace('{EffectFunction}', subShader);
      }
    }
    return this.updateControlsInSource(shaderCode);
  }

  updateShaderCode(shaderCode) {
      if (shaderCode) {
        this.updateOptionFromSource(shaderCode, 'historyTime');
        this.updateOptionFromSource(shaderCode, 'outputCount');
        return this.updateEffectSource(shaderCode)
      }
    return shaderCode;
  }

  getShaderBaseCode() {
    return this.owner.synth.getEffectShaderCode(this.shaderName);
  }

  getProgram() {
    return this.owner.getProgram(
      vertextPull ? SystemShaders.vertexPull : SystemShaders.vertex,
      this._shaderFullCode);
  }
}

export class InputShaderInfo extends SynthShaderInfo {
  /**
   *
   * @param {SynthShaderManager} owner
   * @param {string} shaderName
   */
  constructor (owner, shaderName) {
    super(owner, shaderName)
    this.udpateShader();
  }

  updateInputSource(shaderCode) {
    let subShader = '';
    if (shaderCode.indexOf('#include waveform') !== -1) {
      subShader = shaderCode;
    } else if (shaderCode.indexOf('#include formula') !== -1) {
      subShader = getFormulaWaveform(shaderCode);
    } else if (shaderCode.indexOf('#include shadertoy') !== -1) {
      // TODO: lot of clashing variable names, so maybe dedicated shadertoy version?
      subShader = getShaderToyWaveform(shaderCode);
    } else {
      return this.updateControlsInSource(shaderCode);
    }
    return this.updateControlsInSource(
      SystemShaders.waveform.replace('{WaveformFunction}', subShader));
  }

  updateShaderCode(shaderBaseCode) {
    if (shaderBaseCode) {
      let ix = shaderBaseCode.indexOf('#historyTime');
      if (ix !== -1) {
        let valStr = '';
        ix += 12;
        for (; ix < shaderBaseCode.length; ix++) {
          let c = shaderBaseCode[ix];
          if (c >= '0' && c <= '9' || c === '.') {
            valStr += c;
          } else if (c === '\n' || c === '/') {
            break;
          }
        }
        this.options.historyTime = Number.parseFloat(valStr);
        console.log('History value: ', valStr);
      }
      return this.updateInputSource(shaderBaseCode);
    }
    return shaderBaseCode;
  }

  getShaderBaseCode() {
    return this.owner.synth.getSynthShaderCode(this.shaderName);
  }

  getProgram() {
    return this.owner.getProgram(
      vertextPull ? SystemShaders.vertexPull : SystemShaders.vertex,
      this._shaderFullCode);
  }
}


export class SynthShaderManager {
  /**
   *
   * @param {WebGLSynth} synth
   */
  constructor(synth) {
    this.synth = synth;
    this.gl = synth.gl;
    this.inputShaders = {};
    this.effectShaders = {};
    this.controls = new WebGLSynthControls();
    this.controls.createDefaultMidiControls();
  }
  //#region "Shader stuff"
  // ******************************************
  // ****** Shader loading and compiling ******
  // ******************************************
  getDefaultDefines() {
    let resultStr = `
#define bufferHeight ${~~this.synth.bufferHeight}
#define bufferWidth ${~~this.synth.bufferWidth}
#define bufferCount ${~~(this.synth.bufferCount / 2)}
#define sampleRate ${~~this.synth.sampleRate}
`;
    return resultStr;
  }

  /**
   * Get program with default defines added
   * @param {*} vertexSrc
   * @param {*} framentSrc
   */
  getProgram(vertexSrc, framentSrc) {
    return this.gl.getShaderProgram(
      this.getDefaultDefines() + vertexSrc,
      this.getDefaultDefines() + framentSrc, 2);
  }

  /**
   *
   * @param {string} shaderName
   * @returns {InputShaderInfo}
   */
  getInputSource(shaderName) {
    let shader = this.inputShaders[shaderName];
    if (shader) {
      return shader;
    }
    let shaderCode = this.synth.getSynthShaderCode(shaderName);
    if (shaderCode) {
      shader = new InputShaderInfo(this, shaderName);
      this.inputShaders[shaderName] = shader;
      return shader;
    }
    if (shaderName) {
      console.warn('Input shader not found: ', shaderName);
    }
    return null;
  }

  /**
   *
   * @param {string} shaderName
   * @returns {EffectShaderInfo}
   */
  getEffectSource(shaderName) {
    let shader = this.effectShaders[shaderName];
    if (shader) {
      return shader;
    }
    let shaderCode = this.synth.getEffectShaderCode(shaderName); // EffectShaders[shaderName];
    if (shaderCode) {
      shader = new EffectShaderInfo(this, shaderName);
      this.effectShaders[shaderName] = shader;
      return shader;
    }
    if (shaderName) {
      console.warn('Effect shader not found: ', shaderName);
    }
    return null;
  }

  compileShader(type, name, source, options) {
    if (type === 'effect') {
      return this.compileEffect(name, source, options)
    } else {
      return this.compileSynth(name, source, options)
    }
  }

  compileSynth(name, source, options) {
    let shader = this.getInputSource(name);
    const compileInfo = this.gl.getCompileInfo(this.getDefaultDefines() + shader.updateInputSource(source), this.gl.FRAGMENT_SHADER, 2);
    if (compileInfo.compileStatus) {
      shader.udpateShader(source);
      console.info('Synth shader compiled OK');
    } else {
      console.log('Shader error: ', compileInfo);
    }
    return compileInfo
  }

  compileEffect(name, source, options) {
    let shader = this.getEffectSource(name);
    const compileInfo = this.gl.getCompileInfo(this.getDefaultDefines() + shader.updateEffectSource(source), this.gl.FRAGMENT_SHADER, 2);
    if (compileInfo.compileStatus) {
      shader.udpateShader(source);
      console.info('Effect shader compiled OK');
    } else {
      console.log('Shader error: ', compileInfo);
    }
    return compileInfo
  }
  // #endregion

}