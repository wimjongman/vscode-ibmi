
const vscode = require('vscode');
const path = require('path');

const errorHandler = require('./errorHandle');
const IBMiContent = require('./IBMiContent');
const { connect } = require('http2');

const diagnosticSeverity = {
  0: vscode.DiagnosticSeverity.Information,
  10: vscode.DiagnosticSeverity.Information,
  20: vscode.DiagnosticSeverity.Warning,
  30: vscode.DiagnosticSeverity.Error,
  40: vscode.DiagnosticSeverity.Error,
  50: vscode.DiagnosticSeverity.Error
}

/** @type {vscode.DiagnosticCollection} */
var ileDiagnostics;

/** @type {vscode.OutputChannel} */
var outputChannel;

module.exports = class CompileTools {

  /**
   * @param {vscode.ExtensionContext} context
   */
  static register(context) {
    if (!ileDiagnostics) {
      ileDiagnostics = vscode.languages.createDiagnosticCollection("ILE");
      context.subscriptions.push(ileDiagnostics);
    }

    if (!outputChannel) {
      outputChannel = vscode.window.createOutputChannel("IBM i Output");
      context.subscriptions.push(outputChannel);
    }
  }
  
  /**
   * @param {*} instance
   * @param {{lib: string, object: string, ext?: string}} evfeventInfo
   */
  static async refreshDiagnostics(instance, evfeventInfo) {
    const content = instance.getContent();

    const tableData = await content.getTable(evfeventInfo.lib, 'EVFEVENT', evfeventInfo.object);
    const lines = tableData.map(row => row.EVFEVENT);

    const errors = errorHandler(lines);

    /** @type {vscode.Diagnostic[]} */
    var diagnostics = [];

    /** @type {vscode.Diagnostic} */
    var diagnostic;

    if (Object.keys(errors).length > 0) {
      for (const file in errors) {
        diagnostics = [];
        
        for (const error of errors[file]) {

          error.column = Math.max(error.column-1, 0);
          error.linenum = Math.max(error.linenum-1, 0);

          if (error.column === 0 && error.toColumn === 0) {
            error.column = 0;
            error.toColumn = 100;
          }
          
          diagnostic = new vscode.Diagnostic(
            new vscode.Range(error.linenum, error.column, error.linenum, error.toColumn),
            `${error.code}: ${error.text}`,
            diagnosticSeverity[error.sev]
          );

          diagnostics.push(diagnostic);
        }

        if (file.startsWith('/'))
          ileDiagnostics.set(vscode.Uri.parse(`streamfile:${file}`), diagnostics);
        else
          ileDiagnostics.set(vscode.Uri.parse(`member:/${file}${evfeventInfo.ext ? '.' + evfeventInfo.ext : ''}`), diagnostics);
        
      }

    } else {
      ileDiagnostics.clear();
    }


  }

  /**
   * @param {*} instance
   * @param {vscode.Uri} uri
   * @returns {Promise<boolean>} Whether compiled or not.
   */
  static async RunAction(instance, uri) {
    var evfeventInfo = {lib: '', object: ''};

    const config = vscode.workspace.getConfiguration('code-for-ibmi');
    const allActions = config.get('actions');

    const extension = uri.path.substring(uri.path.lastIndexOf('.')+1).toUpperCase();

    //We do this for backwards compatability.
    //Can be removed in a few versions.
    for (var action of allActions) {
      if (action.extension) action.extensions = [action.extension];
      if (action.extensions) action.extensions = action.extensions.map(ext => ext.toUpperCase());
    }

    const availableActions = allActions.filter(action => action.fileSystem === uri.scheme && (action.extensions.includes(extension) || action.extensions.includes('GLOBAL')));

    if (availableActions.length > 0) {
      const options = availableActions.map(item => item.name);
    
      var chosenOptionName, command;
    
      if (options.length === 1) {
        chosenOptionName = options[0]
      } else {
        chosenOptionName = await vscode.window.showQuickPick(options);
      }
    
      if (chosenOptionName) {
        command = availableActions.find(action => action.name === chosenOptionName).command;

        let basename, name, ext;

        switch (uri.scheme) {
          case 'member':
            const [blank, lib, file, fullName] = uri.path.split('/');
            name = fullName.substring(0, fullName.lastIndexOf('.'));

            ext = (fullName.includes('.') ? fullName.substring(fullName.lastIndexOf('.') + 1) : undefined);

            evfeventInfo = {
              lib: lib,
              object: name,
              ext
            };

            command = command.replace(new RegExp('&OPENLIB', 'g'), lib);
            command = command.replace(new RegExp('&OPENSPF', 'g'), file);
            command = command.replace(new RegExp('&OPENMBR', 'g'), name);

            break;

          case 'streamfile':
            basename = path.posix.basename(uri.path);
            name = basename.substring(0, basename.lastIndexOf('.')).toUpperCase();
            ext = (basename.includes('.') ? basename.substring(basename.lastIndexOf('.') + 1) : undefined);

            evfeventInfo = {
              lib: config.get('buildLibrary'),
              object: name,
              ext
            };

            command = command.replace(new RegExp('&BUILDLIB', 'g'), config.get('buildLibrary'));
            command = command.replace(new RegExp('&FULLPATH', 'g'), uri.path);
            command = command.replace(new RegExp('&NAME', 'g'), name);

            break;
        }

        if (command.startsWith('?')) {
          command = await vscode.window.showInputBox({prompt: "Run action", value: command.substring(1)})
        }

        if (command) {
          const connection = instance.getConnection();

          outputChannel.append("Command: " + command + '\n');

          command = `system ${connection.logCompileOutput ? '' : '-s'} "${command}"`;

          const libl = connection.libraryList.slice(0).reverse();

          var output, compiled = false;

          try {
            output = await connection.qshCommand([
              'liblist -d ' + connection.defaultUserLibraries.join(' '),
              'liblist -a ' + libl.join(' '),
              command
            ], undefined, 1);

            if (output.code === 0 || output.code === null) {
              compiled = true;
              vscode.window.showInformationMessage(`Action ${chosenOptionName} for ${evfeventInfo.lib}/${evfeventInfo.object} was successful.`);
              
            } else {
              compiled = false;
              vscode.window.showErrorMessage(`Action ${chosenOptionName} for ${evfeventInfo.lib}/${evfeventInfo.object} was not successful.`);
            }

            output = `${output.stderr}\n\n${output.stdout}\n\n`;

          } catch (e) {
            output = e;
            compiled = false;

            vscode.window.showErrorMessage(`Action ${chosenOptionName} for ${evfeventInfo.lib}/${evfeventInfo.object} failed. (internal error).`);
          }

          outputChannel.append(output + '\n');

          if (command.includes('*EVENTF')) {
            this.refreshDiagnostics(instance, evfeventInfo);
          }

          return compiled;

        }
      }

    } else {
      //No compile commands
      vscode.window.showErrorMessage(`No compile commands found for ${uri.scheme}-${extension}.`);
    }

    return false;
  }

  /**
   * @param {*} instance
   * @param {string} source Source content.
   */
  static async RunDebug(instance, source) {
    const lines = source.split('\n');

    if (lines[0].startsWith('**FREE')) {
      let newLines = lines;
      let line;

      let debugLines = [];

      for (let i = lines.length-1; i >= 0; i--) {
        line = lines[i].trim().toUpperCase();

        if (line.includes('=')) {
          if (!line.startsWith('IF') && !line.startsWith('WHEN') && !line.startsWith('//')) {
            debugLines.push(i);
            newLines.splice(i, 0, `xlinex = ${i+1};`, `DUMP(A);`);
          }
        }

        if (line.startsWith("DCL-S")) {
          newLines.splice(i+1, 0, `DCL-S xlinex uns(5);`);
          break;
        }
      }

      debugLines = debugLines.reverse();

      const connection = instance.getConnection();
      /** @type {IBMiContent} */
      const contentApi = instance.getContent();

      const libl = connection.libraryList.slice(0).reverse();

      await contentApi.writeStreamfile("/tmp/temp.rpgle", newLines.join('\n'));
      await connection.paseCommand(`/QOpenSys/usr/bin/setccsid 1252 /tmp/temp.rpgle`)
      const output = await connection.qshCommand([
        'liblist -d ' + connection.defaultUserLibraries.join(' '),
        'liblist -a ' + libl.join(' '),
        `system -s "CRTBNDRPG PGM(ILEDITOR/DEBUGME) SRCSTMF('/tmp/temp.rpgle') OPTION(*EVENTF) TGTRLS(*CURRENT)"`,
        `system "call ILEDITOR/DEBUGME"`
      ], undefined, 1);

      console.log(output.stdout.split('\n'));

    } else {
      vscode.window.showInformationMessage("Debug only supports total free format.");
    }
  }
}