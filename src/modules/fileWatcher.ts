import * as vscode from 'vscode';
import * as path from 'path';
import { CONFIG_GLOB_PATTERN, CONGIF_FILENAME, DEPRECATED_CONGIF_FILENAME } from '../constants';
import { isValidFile } from '../helper/documentFilter';
import throttle from '../helper/throttle';
import { upload } from './sync';
import { getConfig, fillGlobPattern } from './config';
import { removeRemote } from './sync';
import * as output from './output';

let disableWatch = false;

let workspaceWatcher: vscode.Disposable;
const watchers: {
  [x: string]: vscode.FileSystemWatcher,
} = {};

const uploadQueue = [];
const deleteQueue = [];

const ACTION_INTEVAL = 500;

function isConfigFile(uri: vscode.Uri) {
  const filename = path.basename(uri.fsPath);
  return filename === CONGIF_FILENAME || filename === DEPRECATED_CONGIF_FILENAME;
}

function fileError(event, file, showErrorWindow = true) {
  return error => {
    output.error(`${event} ${file}`, '\n', error.stack);
    if (showErrorWindow) {
      output.showOutPutChannel();
    }
  };
}

function doUpload() {
  const files = uploadQueue.slice().map(uri => uri.fsPath).sort();
  uploadQueue.length = 0;
  files.forEach(file => {
    let config;
    try {
      config = getConfig(file);
    } catch (error) {
      output.onError(error);
      return;
    }

    upload(file, config, true).catch(fileError('upload', file));
  });
}

function doDelete() {
  const files = deleteQueue.slice().map(uri => uri.fsPath).sort();
  deleteQueue.length = 0;
  let config;
  files.forEach(file => {
    try {
      config = getConfig(file);
    } catch (error) {
      output.onError(error);
      return;
    }

    removeRemote(
      config.remotePath,
      {
        ...config,
        skipDir: true,
      },
      true
    ).catch(fileError('delete', config.remotePath, false));
  });
}

const throttledUpload = throttle(doUpload, ACTION_INTEVAL);
const throttledDelete = throttle(doDelete, ACTION_INTEVAL);

function uploadHandler(uri: vscode.Uri) {
  if (disableWatch) {
     return;
  }

  if (!isValidFile(uri)) {
    return;
  }

  uploadQueue.push(uri);
  throttledUpload();
}

function setUpWatcher(config) {
  const watchConfig = config.watcher !== undefined ? config.watcher : {};

  let watcher = watchers[config.configRoot];
  if (watcher) {
    // clear old watcher
    watcher.dispose();
  }

  const shouldAddListenser = watchConfig.autoUpload || watchConfig.autoDelete;
  // tslint:disable-next-line triple-equals
  if (watchConfig.files == false || !shouldAddListenser) {
    return;
  }

  const pattern = fillGlobPattern(watchConfig.files, config.configRoot);
  watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
  watchers[config.configRoot] = watcher;

  if (watchConfig.autoUpload) {
    watcher.onDidCreate(uploadHandler);
    watcher.onDidChange(uploadHandler);
  }

  if (watchConfig.autoDelete) {
    watcher.onDidDelete(uri => {
      if (disableWatch) {
        return;
      }

      if (!isValidFile(uri)) {
        return;
      }

      deleteQueue.push(uri);
      throttledDelete();
    });
  }
}

export function disableWatcher() {
  disableWatch = true;
}

export function enableWatcher() {
  if (!disableWatch) {
    return;
  }

  // delay because change happens after this, need make sure this execute after change event
  setTimeout(() => {
    disableWatch = false;
  }, 2000);
}

export function watchWorkspace({
  onDidSaveFile,
  onDidSaveSftpConfig,
}: {
  onDidSaveFile: (uri: vscode.Uri) => void,
  onDidSaveSftpConfig: (uri: vscode.Uri) => void,
}) {
  if (workspaceWatcher) {
    workspaceWatcher.dispose();
  }

  workspaceWatcher = vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
    const uri = doc.uri;
    if (!isValidFile(uri)) {
      return;
    }

    // let configWatcher do this
    if (isConfigFile(uri)) {
      onDidSaveSftpConfig(uri);
      return;
    }

    onDidSaveFile(uri);
  });
}

export function watchFiles(config) {
  const configs = [].concat(config);
  configs.forEach(setUpWatcher);
}

export function clearAllWatcher() {
  const disposable = vscode.Disposable.from(
    ...Object.keys(watchers).map(key => watchers[key]),
    workspaceWatcher
  );
  disposable.dispose();
}
