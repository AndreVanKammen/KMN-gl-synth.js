// This is a new piece of code ment to get better performance for managing shaders and memory
// It is unfinished and not in use

import SynthPlayData from "./webgl-synth-data.js";
import { SynthShaderInfo } from "./webgl-synth-shader-manager.js";
class ShaderNode {
  /**
   * A node for a shader
   * @param {ShaderPath} path
   * @param {string} shaderName
   * @param {boolean} isStart
   * @param {SynthShaderInfo} shaderInfo
   */
  constructor(path, shaderName, isStart, shaderInfo) {
    this.path = path
    this.nodeNr = -1;
    this.passNr = -1;
    this.shaderName = shaderName;
    this.isStart = isStart;
    this.shaderInfo = shaderInfo;

    this.startPassNr = -1;
    this.maxPassNr = -1;
    this.preferredStartPassNr = -1;
    this.preferredMaxPassNr = -1;
    this.preferredPassNr = -1;
  }
  toString() {
    return this.shaderName;
  }
}
class ShaderPath {
  /**
   * Creates a path, a path is an array of shaders that is to be executed in sequence
   * @param {PlanLine} line
   * @param {number} startPassNr
   */
  constructor(line, startPassNr) {
    this.line = line;
    /** @type {Array<ShaderNode>} */
    this.entries = [];
    /** @type {ShaderPath} */
    this.outputPath = undefined;
    this.pathNr = -1;
    this.startPassNr = startPassNr;
  }

  add(effectName, isInput, synthEffect) {
    let node = new ShaderNode(this, effectName, isInput, synthEffect)
    this.entries.push(node);
    this.line.planner.nodes.push(node);
  }

  getMaxStart() {
    if (this.outputPath) {
      return this.outputPath.getMaxStart() - this.entries.length;
    } else {
      return this.startPassNr;
    }
  }

  increasePassNrs(startPassNr) {
    let pasNr = startPassNr;
    if (startPassNr > this.startPassNr) {
      this.startPassNr = pasNr;
      if (this.outputPath) {
        this.updateOutputPassNr();
      }
    }
  }

  updateOutputPassNr() {
    this.outputPath.increasePassNrs(this.startPassNr + this.entries.length);
  }
}
class PlanLine {
  /**
   * One line of execution
   * @param {SynthExecutePlanner} planner
   */
  constructor(planner) {
    this.planner = planner;
    /** @type {Array<ShaderPath>} */
    this.entries = [];
  }
  add(passNr) {
    let path = new ShaderPath(this, passNr)
    this.planner.paths.push(path);
    this.entries.push(path);
    return path;
  }
}

export class SynthExecutePlanner {

  /**
   *
   * @param {SynthPlayData} playData
   */
  constructor(playData) {
    this.playData = playData;
    this.clear();
  }
  clear() {
    /** @type {Array<PlanLine>} */
    this.shaderPlan = [];
    /** @type {Array<ShaderPath>} */
    this.paths = [];
    /** @type {Array<ShaderNode>} */
    this.nodes = [];
    /** @type {ShaderNode[][][]} */
    this.batches = [];
  }

  buildShaderPlan() {
    this.clear();
    /** @type {Record<number,ShaderPath>} */
    let handledMixers = {};
    for (let startMixer of this.playData.startMixers) {
      let shaderPlanLine = new PlanLine(this);
      let passNr = 0;
      this.shaderPlan.push(shaderPlanLine);

      let shaderPath = shaderPlanLine.add(passNr);
      // Add path for notes and input streams, this path will be multiplied by notes playing
      {
        shaderPath.add(startMixer.inputShaderName, true);
        for (let synthEffect of startMixer.effects) {
          shaderPath.add(synthEffect.shaderName, false, synthEffect);
        }
        passNr += shaderPath.entries.length;
      }

      // Add all the mixer paths
      let traceEntry = startMixer.mixer;
      while (traceEntry) {
        {
          let handledMixerData = handledMixers[traceEntry.mixerHash]
          if (handledMixerData) {
            shaderPath.outputPath = handledMixerData;
            shaderPath.updateOutputPassNr();
            break;
          }
        }
        shaderPath = shaderPath.outputPath = shaderPlanLine.add(passNr);
        handledMixers[traceEntry.mixerHash] = shaderPath
        for (let synthEffect of traceEntry.effects) {
          shaderPath.add(synthEffect.shaderName, false, synthEffect);
        }
        traceEntry = traceEntry?.mixer;
        passNr += shaderPath.entries.length;
      }
    }
    this.shaderPlan.reverse();
  }

  assignPassNrs() {
    // TODO: Merge shaders if posible


    /** @type {Record<string,ShaderNode[]>} */
    let allShaders = {}
    for (let planLine of this.shaderPlan) {
      for (let shaderPath of planLine.entries) {
        let startPassNr = shaderPath.startPassNr;
        let maxPassNr = shaderPath.getMaxStart();
        for (let node of shaderPath.entries) {
          node.startPassNr = startPassNr++;
          node.maxPassNr = maxPassNr++;
          // TODO same shader in series can mess up batching min-max
          let shaderKey = node.shaderName + (((node.maxPassNr & 1)==1) ? '_o': '_e');
          let shaderCollector = allShaders[shaderKey];
          if (!shaderCollector) {
            shaderCollector = allShaders[shaderKey] = [];
          }
          this.maxPassNr = Math.max(maxPassNr);
          shaderCollector.push(node);
        }
      }
    }
    for (let [shaderName,nodes] of Object.entries(allShaders)) {
      let startPassNr = 0;
      let maxPassNr = 1000000;
      for (let node of nodes) {
        startPassNr = Math.max(startPassNr, node.startPassNr);
        maxPassNr   = Math.min(maxPassNr,   node.maxPassNr  );
        // console.log('>',node.startPassNr,node.maxPassNr, ' => p('+node.path.pathNr+','+node.path.startPassNr+')');
      }

      for (let node of nodes) {
        node.preferredStartPassNr = startPassNr;
        node.preferredMaxPassNr   = maxPassNr;
        node.preferredPassNr = startPassNr
        if (startPassNr < maxPassNr) {
          // Increase if max is different odd/even. Finnaly a use for xor
          node.preferredPassNr += (maxPassNr & 1) ^ (startPassNr & 1)
        }
      }

      // console.log('range: ', shaderName + `(${nodes.length})`, startPassNr, maxPassNr);
    }

    // TODO ensure order of passNr's

    // TODO: Distribute to back for more equal passes

    // TODO: add copy shaders to line up odd/even if neccessary
  }

  buildBatches() {
    /** @type {Array<Array<ShaderNode>>} */
    let matrix = [];
    for (let planLine of this.shaderPlan) {
      let line = []
      matrix.push(line)
      for (let shaderPath of planLine.entries) {
        for (let node of shaderPath.entries) {
          line[node.preferredPassNr] = node;
        }
      }
    }
    let pathNr = 0;
    let nodeNr = 0
    for (let passNr = 0; passNr < this.maxPassNr; passNr++) {
      let batches = {};
      for (let lineIx = 0; lineIx < matrix.length; lineIx++) {
        let node = matrix[lineIx][passNr];
        if (node){
          node.nodeNr = nodeNr++;
          if (node.path.pathNr === -1) {
            node.path.pathNr = pathNr++;
          }
          let batch = batches[node.shaderName];
          if (!batch) {
            batch = batches[node.shaderName] = [];
          }
          batch.push(node);
        }
      }
      // TODO: sort batches on priority
      this.batches.push(Object.values(batches));
    }
  }

  logPlanToConsole() {
    let debugOutput = '';
    let matrix = [];
    for (let planLine of this.shaderPlan) {
      let pathStrs = [];
      let line = []
      matrix.push(line)
      for (let shaderPath of planLine.entries) {
        let str = 'p('+shaderPath.pathNr+','+shaderPath.startPassNr+') '+shaderPath.entries.join(' -> ');
        if (shaderPath.outputPath) {
          str += ' => p('+shaderPath.outputPath.pathNr+','+shaderPath.outputPath.startPassNr+')';
        }
        pathStrs.push(str);
        for (let node of shaderPath.entries) {
          if (node.preferredPassNr===-1) {
            console.error('node without pass: ',node);
          }
          line[node.preferredPassNr] = node.shaderName;
        }
      }
      debugOutput += pathStrs.join(' ==> ') + '\n';
    }
    // console.log(debugOutput);
    // console.table(matrix);
    // console.log('paths: ',this.paths);
    // console.log('nodes: ',this.nodes);
    // console.log('batches: ',this.batches);
  }

  rebuild() {
    this.buildShaderPlan();
    this.assignPassNrs();

    // Define batches per pass, grouped by same shader.
    this.buildBatches();

    // TODO: alocate buffers, group buffer by target for one run to output (multiple piano's in same target buffer)
    //       should buffers be alternated to prevent sync issues? Probably not since every step is a sync!

    // TODO: optimize: If it needs RMS from previous pass it should go last

    // TODO: assign trackdata per node

    this.logPlanToConsole();
  }

  execute(passCount, synthTime) {
    // TODO: check for inputs with 0 output in their last shader for their path to end them

    // TODO: update input buffers for number of inputs playing

    // TODO: Update setting buffers
    // TODO: Update control buffers

    // TODO: Update trackData time, phaseTime(once per channel)
    // TODO: For all passes do all batches then all measures
    //
  }
}


