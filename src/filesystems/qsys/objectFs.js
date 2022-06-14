
const vscode = require(`vscode`);
const instance = require(`../../Instance`);
const Tools = require(`../../api/Tools`);

module.exports = class ObjectFs {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.emitter.event;
  }
  
  /**
   * 
   * @param {vscode.Uri} uri 
   * @returns {Promise<Uint8Array>}
   */
  async readFile(uri) {
    const connection = instance.getConnection();
    const content = instance.getContent();
    const config = instance.getConfig();

    const {library, object, type} = Tools.parseObjectPath(uri.path);
    const tempLib = config.tempLibrary;
    const TempName = Tools.makeid();

    switch (type) {
    case `BNDDIR`:
      await connection.remoteCommand(`DSPBNDDIR BNDDIR(${library}/${object}) OUTPUT(*OUTFILE) OUTFILE(${tempLib}/${TempName})`);
      const rows = await content.getTable(tempLib, TempName, null, true);
      const results = rows.map(row => ({
        object: row.BNOBNM,
        library: row.BNDRLB,
        type: row.BNOBTP,
        activation: row.BNOACT,
        creation: {
          date: row.BNODAT,
          time: row.BNOTIM,
        }
      }));
      return new Uint8Array(Buffer.from(JSON.stringify(results, null, 2), `utf8`));

    default:
      throw new Error(`Unsupported object type: ${type}`);
    }
  }

  /**
   * 
   * @param {vscode.Uri} uri 
   */
  stat(uri) {
    return {file: vscode.FileType.File}
  }
}