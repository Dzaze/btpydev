import * as vscode from 'vscode';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Stockage en mémoire de l'historique des conversations et des logs.
let conversationHistory: Array<{ prompt: string; response: string; timestamp: string }> = [];
let logMessages: string[] = [];

// Références aux panels pour éviter d’en créer plusieurs.
let mainPanel: vscode.WebviewPanel | undefined;
let logPanel: vscode.WebviewPanel | undefined;
let backupPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  addLog("Extension Mistral Assistant activée.");

  // Commande principale : lancer le flux complet (prompt → appel API → prévisualisation → validation/aplication)
  const disposableChat = vscode.commands.registerCommand('extension.modifierProjetAvecMistral', async () => {
    try {
      createOrShowMainWebview(context);
    } catch (error: any) {
      vscode.window.showErrorMessage("Erreur : " + error.message);
      addLog("Erreur dans la commande Mistral : " + error.message);
    }
  });

  // Commande manuelle "Save Me" pour déclencher une sauvegarde
  const disposableSaveMe = vscode.commands.registerCommand('extension.saveMe', async () => {
    try {
      await backupProject();
      vscode.window.showInformationMessage("Backup effectué avec succès.");
      addLog("Commande Save Me exécutée (backup manuel).");
    } catch (error: any) {
      vscode.window.showErrorMessage("Erreur lors du backup : " + error.message);
      addLog("Erreur lors du backup : " + error.message);
    }
  });

  // Commande pour afficher les logs
  const disposableShowLog = vscode.commands.registerCommand('extension.showLog', () => {
    createOrShowLogWebview(context);
  });

  // Commande pour afficher l'interface graphique des backups
  const disposableShowBackups = vscode.commands.registerCommand('extension.showBackups', async () => {
    await createOrShowBackupsWebview(context);
  });

  context.subscriptions.push(disposableChat, disposableSaveMe, disposableShowLog, disposableShowBackups);
}

export function deactivate() {}

/**
 * Récupère ou demande la clé API et la stocke via VS Code Secrets.
 */
async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  let apiKey = await context.secrets.get('mistralApiKey');
  if (!apiKey) {
    apiKey = await vscode.window.showInputBox({
      prompt: 'Entrez votre clé API pour Mistral',
      ignoreFocusOut: true,
      password: true
    });
    if (apiKey) {
      await context.secrets.store('mistralApiKey', apiKey);
      vscode.window.showInformationMessage("Clé API stockée avec succès.");
    }
  }
  return apiKey;
}

/**
 * Appelle l'API Mistral pour obtenir la réponse.
 * Utilise l'endpoint "https://api.mistral.ai/v1/chat/completions" et envoie un payload au format "messages".
 */
async function callMistral(apiKey: string, prompt: string): Promise<string> {
  const apiUrl = 'https://api.mistral.ai/v1/chat/completions';
  const payload = {
    model: "mistral-large-latest",
    messages: [{ role: "user", content: prompt }]
  };

  try {
    const response = await axios.post(apiUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });
    return response.data.choices[0].message.content;
  } catch (error: any) {
    vscode.window.showErrorMessage("Erreur lors de l'appel à Mistral : " + error.message);
    return "Erreur lors de l'appel à l'API.";
  }
}

/**
 * Effectue une sauvegarde des dossiers de l'espace de travail dans un dossier de backup.
 */
async function backupProject(): Promise<void> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    vscode.window.showWarningMessage("Aucun dossier ouvert pour sauvegarde.");
    return;
  }
  const backupFolderSetting = vscode.workspace.getConfiguration('mistralExtension').get<string>('backupFolder');
  const backupFolder = backupFolderSetting || path.join(os.homedir(), '.mistral_backup');

  if (!fs.existsSync(backupFolder)) {
    fs.mkdirSync(backupFolder, { recursive: true });
  }

  for (const folder of vscode.workspace.workspaceFolders) {
    const folderPath = folder.uri.fsPath;
    const folderName = path.basename(folderPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupFolder, `${folderName}_${timestamp}`);
    copyFolderRecursive(folderPath, backupPath);
    vscode.window.showInformationMessage(`Backup de ${folderName} créé dans ${backupPath}`);
    addLog(`Backup de ${folderName} créé (${timestamp}).`);
  }
}

/**
 * Copie récursivement un dossier.
 */
function copyFolderRecursive(source: string, target: string) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, { recursive: true });
  const files = fs.readdirSync(source);
  for (const file of files) {
    const curSource = path.join(source, file);
    const curTarget = path.join(target, file);
    if (fs.lstatSync(curSource).isDirectory()) {
      copyFolderRecursive(curSource, curTarget);
    } else {
      fs.copyFileSync(curSource, curTarget);
    }
  }
}

/**
 * Crée ou affiche la WebView principale (Tableau de bord).
 */
function createOrShowMainWebview(context: vscode.ExtensionContext) {
  if (mainPanel) {
    mainPanel.webview.html = getMainWebviewContent();
    mainPanel.reveal();
  } else {
    mainPanel = vscode.window.createWebviewPanel(
      'mistralMain',
      'Mistral Assistant - Tableau de bord',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    mainPanel.webview.html = getMainWebviewContent();

    mainPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'sendPrompt': {
          const apiKey = await getApiKey(context);
          if (!apiKey) {
            vscode.window.showErrorMessage("Clé API non renseignée.");
            return;
          }
          await backupProject();
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Appel de Mistral...",
            cancellable: false
          }, async (progress) => {
            progress.report({ message: "Envoi de la requête..." });
            const response = await callMistral(apiKey, message.text);
            const timestamp = new Date().toLocaleString();
            conversationHistory.push({ prompt: message.text, response: response, timestamp: timestamp });
            addLog(`Nouvelle conversation enregistrée (${timestamp}).`);
            mainPanel?.webview.postMessage({ command: 'displayResponse', response: response });
          });
          break;
        }
        case 'applyChanges': {
          applyChanges(message.changes);
          break;
        }
        case 'showLogs': {
          vscode.commands.executeCommand('extension.showLog');
          break;
        }
        case 'showBackups': {
          vscode.commands.executeCommand('extension.showBackups');
          break;
        }
        default:
          break;
      }
    }, undefined, context.subscriptions);

    mainPanel.onDidDispose(() => {
      mainPanel = undefined;
    }, null, context.subscriptions);
  }
}

/**
 * Retourne le contenu HTML pour le WebView principal.
 */
function getMainWebviewContent(): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Mistral Assistant - Tableau de bord</title>
  <style>
    body { background-color: #1e1e1e; color: #d4d4d4; font-family: sans-serif; padding: 20px; }
    textarea { width: 100%; height: 100px; }
    button { background: #007acc; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; margin: 5px 0; cursor: pointer; }
    button:hover { background: #005a9e; }
    pre { background: #333; padding: 10px; border-radius: 4px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>Mistral Assistant - Tableau de bord</h1>
  <div>
    <textarea id="prompt" placeholder="Tapez votre requête ici..."></textarea><br/>
    <button onclick="sendPrompt()">Envoyer</button>
    <button onclick="openLogs()">Logs</button>
    <button onclick="openBackups()">Backups</button>
  </div>
  <div id="responseContainer"></div>
  <script>
    const vscode = acquireVsCodeApi();
    function sendPrompt() {
      const promptText = document.getElementById('prompt').value;
      vscode.postMessage({ command: 'sendPrompt', text: promptText });
    }
    function openLogs() {
      vscode.postMessage({ command: 'showLogs' });
    }
    function openBackups() {
      vscode.postMessage({ command: 'showBackups' });
    }
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'displayResponse') {
        document.getElementById('responseContainer').innerHTML =
          '<h2>Modifications proposées :</h2><pre>' + message.response + '</pre>' +
          '<button onclick="applyAllChanges()">Appliquer toutes les modifications</button>';
      }
    });
    function applyAllChanges() {
      vscode.postMessage({ command: 'applyChanges', changes: {} });
    }
  </script>
</body>
</html>`;
}

/**
 * Applique les modifications (fonctionnalité à développer selon vos besoins).
 */
function applyChanges(changes: any) {
  backupProject();
  vscode.window.showInformationMessage("Modifications appliquées avec succès !");
  addLog("Modifications appliquées.");
}

/**
 * Crée ou affiche le WebView des logs.
 */
function createOrShowLogWebview(context: vscode.ExtensionContext) {
  if (logPanel) {
    logPanel.webview.html = getLogWebviewContent();
    logPanel.reveal();
  } else {
    logPanel = vscode.window.createWebviewPanel(
      'logwebview',
      'Logs Mistral Assistant',
      vscode.ViewColumn.Two,
      { enableScripts: true }
    );
    logPanel.webview.html = getLogWebviewContent();
    logPanel.onDidDispose(() => { logPanel = undefined; }, null, context.subscriptions);
  }
}

/**
 * Retourne le contenu HTML pour le WebView des logs.
 */
function getLogWebviewContent(): string {
  const logsHtml = logMessages.map(log => `<div>${log}</div>`).join("");
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Logs</title>
  <style>
    body { background-color: #1e1e1e; color: #d4d4d4; font-family: monospace; padding: 20px; }
    div { margin-bottom: 5px; }
    button { background: #007acc; color: white; border: none; padding: 8px 12px; border-radius: 3px; cursor: pointer; margin-bottom: 20px; }
    button:hover { background: #005a9e; }
  </style>
</head>
<body>
  <button onclick="location.reload()">Rafraîchir</button>
  <h2>Logs</h2>
  ${logsHtml || "<p>Aucun log enregistré.</p>"}
</body>
</html>`;
}

/**
 * Crée ou affiche le WebView des backups.
 */
async function createOrShowBackupsWebview(context: vscode.ExtensionContext) {
  const backupFolderSetting = vscode.workspace.getConfiguration('mistralExtension').get<string>('backupFolder');
  const backupFolder = backupFolderSetting || path.join(os.homedir(), '.mistral_backup');

  if (backupPanel) {
    backupPanel.webview.html = getBackupsWebviewContent(backupFolder);
    backupPanel.reveal();
  } else {
    backupPanel = vscode.window.createWebviewPanel(
      'backupwebview',
      'Interface des Backups',
      vscode.ViewColumn.Three,
      { enableScripts: true }
    );
    backupPanel.webview.html = getBackupsWebviewContent(backupFolder);

    backupPanel.webview.onDidReceiveMessage(message => {
      if (message.command === 'openBackup' && message.path) {
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(message.path), { forceNewWindow: false });
      }
    }, undefined, context.subscriptions);

    backupPanel.onDidDispose(() => { backupPanel = undefined; }, null, context.subscriptions);
  }
}

/**
 * Retourne le contenu HTML pour le WebView des backups.
 */
function getBackupsWebviewContent(backupFolder: string): string {
  let backupsList = "";
  if (fs.existsSync(backupFolder)) {
    const backups = fs.readdirSync(backupFolder);
    if (backups.length > 0) {
      backupsList = backups.map(backup => {
        const fullPath = path.join(backupFolder, backup);
        return `<div class="backup-item">
                  <span>${backup}</span>
                  <button onclick="openBackup('${fullPath.replace(/\\/g, '\\\\')}')">Ouvrir</button>
                </div>`;
      }).join("");
    } else {
      backupsList = "<p>Aucun backup trouvé.</p>";
    }
  } else {
    backupsList = "<p>Dossier de backup introuvable.</p>";
  }

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Backups</title>
  <style>
    body { background-color: #1e1e1e; color: #d4d4d4; font-family: sans-serif; padding: 20px; }
    .backup-item { margin-bottom: 10px; padding: 10px; background: #333; border-radius: 5px; display: flex; justify-content: space-between; align-items: center; }
    button { background: #007acc; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; }
    button:hover { background: #005a9e; }
  </style>
</head>
<body>
  <h1>Liste des Backups</h1>
  ${backupsList}
  <script>
    const vscode = acquireVsCodeApi();
    function openBackup(path) {
      vscode.postMessage({ command: 'openBackup', path: path });
    }
  </script>
</body>
</html>`;
}

/**
 * Ajoute un message au log avec un timestamp.
 */
function addLog(message: string) {
  const timestamp = new Date().toISOString();
  logMessages.push(`[${timestamp}] ${message}`);
}
