const otherControls = {
  // send by other messages in channel
  program: 128,
  pitch: 129,
  pressure: 130,
  pitchRange: 131,

  // RPN within MIDI spec
  tuning: 132,
  tuningProgram: 133,
  tuningBank: 134,
  modulationDepth: 135,

  // Send with note
  note: 136,
  velocity: 137,
  releaseVelocity: 138,
  aftertouch: 139,

  // Made up by me
  playDirection: 140
}

export { otherControls }
