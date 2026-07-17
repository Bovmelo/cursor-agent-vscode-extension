import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { configurationFor } from "./workspaceFolder.js";

const CONFIG_SECTION = "cursorSubscription";
const CONFIG_KEY = "playSoundWhileRunning";
const COMPLETION_CONFIG_KEY = "playSoundOnComplete";
const ERROR_CONFIG_KEY = "playSoundOnError";
const SOUND_FILE_NAME = "calm-running-sound.wav";
const COMPLETION_SOUND_FILE_NAME = "completion-sound.wav";
const ERROR_SOUND_FILE_NAME = "error-sound.wav";

export class RunningSoundController implements vscode.Disposable {
  private activeRuns = 0;
  private player: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private soundFile: Promise<vscode.Uri> | undefined;
  private completionSoundFile: Promise<vscode.Uri> | undefined;
  private errorSoundFile: Promise<vscode.Uri> | undefined;
  private readonly oneShotPlayers = new Set<ChildProcess>();
  private disposed = false;
  private readonly configurationDisposable: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.configurationDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEY}`)) {
        this.syncPlayback();
      }
    });
  }

  public start(): vscode.Disposable {
    this.activeRuns += 1;
    this.syncPlayback();

    let active = true;
    return new vscode.Disposable(() => {
      if (!active) {
        return;
      }
      active = false;
      this.activeRuns = Math.max(0, this.activeRuns - 1);
      this.syncPlayback();
    });
  }

  public playCompletion(): void {
    this.playOneShot(
      () => this.ensureCompletionSoundFile(),
      () => this.completionEnabled(),
      "completion",
    );
  }

  public playError(): void {
    this.playOneShot(
      () => this.ensureErrorSoundFile(),
      () => this.errorEnabled(),
      "error",
    );
  }

  public dispose(): void {
    this.disposed = true;
    this.activeRuns = 0;
    this.configurationDisposable.dispose();
    this.stopPlayer();
    for (const player of this.oneShotPlayers) {
      if (!player.killed) {
        player.kill();
      }
    }
    this.oneShotPlayers.clear();
  }

  private enabled(): boolean {
    return this.configuration().get<boolean>(CONFIG_KEY, true);
  }

  private completionEnabled(): boolean {
    return this.configuration().get<boolean>(COMPLETION_CONFIG_KEY, true);
  }

  private errorEnabled(): boolean {
    return this.configuration().get<boolean>(ERROR_CONFIG_KEY, true);
  }

  private configuration(): vscode.WorkspaceConfiguration {
    return configurationFor(CONFIG_SECTION);
  }

  private playOneShot(
    ensureFile: () => Promise<vscode.Uri>,
    enabled: () => boolean,
    label: string,
  ): void {
    if (this.disposed || !enabled() || process.platform !== "win32") {
      return;
    }

    void ensureFile()
      .then((soundUri) => {
        if (this.disposed || !enabled()) {
          return;
        }
        const player = this.spawnSoundPlayer(soundUri, false);
        this.oneShotPlayers.add(player);
        const removePlayer = (): void => {
          this.oneShotPlayers.delete(player);
        };
        player.once("error", (error) => {
          removePlayer();
          this.output.appendLine(
            `[${new Date().toISOString()}] Could not play ${label} sound: ${error.message}`,
          );
        });
        player.once("exit", removePlayer);
      })
      .catch((error: unknown) => {
        this.output.appendLine(
          `[${new Date().toISOString()}] Could not prepare ${label} sound: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  private syncPlayback(): void {
    if (
      this.disposed
      || this.activeRuns === 0
      || !this.enabled()
      || process.platform !== "win32"
    ) {
      this.stopPlayer();
      return;
    }

    if (!this.player && !this.starting) {
      this.starting = this.startPlayer()
        .catch((error: unknown) => {
          this.output.appendLine(
            `[${new Date().toISOString()}] Could not prepare running sound: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          this.starting = undefined;
        });
    }
  }

  private async startPlayer(): Promise<void> {
    const soundUri = await this.ensureSoundFile();
    if (
      this.disposed
      || this.activeRuns === 0
      || !this.enabled()
      || this.player
    ) {
      return;
    }

    const player = this.spawnSoundPlayer(soundUri, true);
    this.player = player;
    player.once("error", (error) => {
      if (this.player === player) {
        this.player = undefined;
      }
      this.output.appendLine(
        `[${new Date().toISOString()}] Could not play running sound: ${error.message}`,
      );
    });
    player.once("exit", () => {
      if (this.player === player) {
        this.player = undefined;
      }
    });
  }

  private stopPlayer(): void {
    const player = this.player;
    this.player = undefined;
    if (player && !player.killed) {
      player.kill();
    }
  }

  private spawnSoundPlayer(soundUri: vscode.Uri, looping: boolean): ChildProcess {
    const escapedPath = soundUri.fsPath.replaceAll("'", "''");
    const script = [
      "$player = New-Object System.Media.SoundPlayer",
      `$player.SoundLocation = '${escapedPath}'`,
      "$player.Load()",
      looping ? "$player.PlayLooping()" : "$player.PlaySync()",
      ...(looping ? ["while ($true) { Start-Sleep -Seconds 3600 }"] : []),
    ].join("; ");
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    const executable = process.env.SystemRoot
      ? path.join(
          process.env.SystemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        )
      : "powershell.exe";
    return spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encodedScript,
      ],
      {
        windowsHide: true,
        stdio: "ignore",
      },
    );
  }

  private ensureSoundFile(): Promise<vscode.Uri> {
    if (!this.soundFile) {
      this.soundFile = this.writeSoundFile();
    }
    return this.soundFile;
  }

  private ensureCompletionSoundFile(): Promise<vscode.Uri> {
    if (!this.completionSoundFile) {
      this.completionSoundFile = this.writeCompletionSoundFile();
    }
    return this.completionSoundFile;
  }

  private ensureErrorSoundFile(): Promise<vscode.Uri> {
    if (!this.errorSoundFile) {
      this.errorSoundFile = this.writeErrorSoundFile();
    }
    return this.errorSoundFile;
  }

  private async writeSoundFile(): Promise<vscode.Uri> {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const soundUri = vscode.Uri.joinPath(this.context.globalStorageUri, SOUND_FILE_NAME);
    await vscode.workspace.fs.writeFile(soundUri, createCalmRunningSound());
    return soundUri;
  }

  private async writeCompletionSoundFile(): Promise<vscode.Uri> {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const soundUri = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      COMPLETION_SOUND_FILE_NAME,
    );
    await vscode.workspace.fs.writeFile(soundUri, createCompletionSound());
    return soundUri;
  }

  private async writeErrorSoundFile(): Promise<vscode.Uri> {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const soundUri = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      ERROR_SOUND_FILE_NAME,
    );
    await vscode.workspace.fs.writeFile(soundUri, createErrorSound());
    return soundUri;
  }
}

function createCalmRunningSound(): Uint8Array {
  return createPcmWav(5, (time) =>
    synthTone(time, 0.08, 0.5, 261.63, 0.05, 0.1, 0.22)
    + synthTone(time, 0.24, 0.65, 329.63, 0.038, 0.1, 0.25)
  );
}

function createCompletionSound(): Uint8Array {
  return createPcmWav(1.2, (time) =>
    synthTone(time, 0.06, 0.3, 392, 0.042, 0.025, 0.12)
    + synthTone(time, 0.2, 0.34, 523.25, 0.038, 0.025, 0.14)
    + synthTone(time, 0.36, 0.4, 659.25, 0.032, 0.03, 0.18)
  );
}

function createErrorSound(): Uint8Array {
  return createPcmWav(1.05, (time) =>
    synthTone(time, 0.04, 0.28, 415.3, 0.048, 0.02, 0.12)
    + synthTone(time, 0.2, 0.3, 311.13, 0.044, 0.02, 0.14)
    + synthTone(time, 0.38, 0.42, 233.08, 0.04, 0.025, 0.2)
  );
}

function synthTone(
  time: number,
  start: number,
  duration: number,
  frequency: number,
  volume: number,
  attackSeconds: number,
  releaseSeconds: number,
): number {
  const elapsed = time - start;
  if (elapsed < 0 || elapsed >= duration) {
    return 0;
  }
  const attack = Math.min(1, elapsed / attackSeconds);
  const release = Math.min(1, (duration - elapsed) / releaseSeconds);
  const envelope = attack * release * Math.exp(-1.5 * elapsed / duration);
  const fundamental = Math.sin(2 * Math.PI * frequency * elapsed);
  const softHarmonic = 0.08 * Math.sin(4 * Math.PI * frequency * elapsed);
  return volume * envelope * (fundamental + softHarmonic);
}

function createPcmWav(
  durationSeconds: number,
  sampleAt: (time: number) => number,
): Uint8Array {
  const sampleRate = 44_100;
  const sampleCount = Math.round(sampleRate * durationSeconds);
  const bytesPerSample = 2;
  const wav = Buffer.alloc(44 + sampleCount * bytesPerSample);

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(sampleCount * bytesPerSample, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const sample = sampleAt(time);
    const normalized = Math.max(-1, Math.min(1, sample));
    wav.writeInt16LE(Math.round(normalized * 32_767), 44 + index * bytesPerSample);
  }

  return wav;
}
