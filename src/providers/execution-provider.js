class ExecutionProvider {
  constructor(name) {
    this.name = name;
  }

  async executeTask() {
    throw new Error('ExecutionProvider.executeTask must be implemented.');
  }
}

module.exports = { ExecutionProvider };
