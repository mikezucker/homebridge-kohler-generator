import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ExamplePlatformAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

// This is only required when using Custom Services and Characteristics not support by HomeKit
import { EveHomeKitTypes } from 'homebridge-lib/EveHomeKitTypes';

const execFileAsync = promisify(execFile);

export type KohlerStatus = {
  deviceId: number;
  name: string;
  isConnected?: boolean;
  status?: string;
  controllerType?: string;
  powerSource?: string; // "Utility" / "Generator" etc
  switchState?: string; // "Auto" etc
  engineState?: string; // "Standby" / "Running" etc
  alertCount?: number;
  batteryVoltageV?: number;
  utilityVoltageV?: number;
  generatorLoadPercent?: number;
};

export class KohlerGeneratorPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  // Custom services/characteristics (not required for our initial generator tiles, but leaving intact)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomServices: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomCharacteristics: any;

  private pollTimer?: NodeJS.Timeout;
  private pollInFlight = false;
  private consecutivePollFailures = 0;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.CustomServices = new EveHomeKitTypes(this.api).Services;
    this.CustomCharacteristics = new EveHomeKitTypes(this.api).Characteristics;

    this.log.debug('Finished initializing platform:', this.config?.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private getPollMs(): number {
    const pollSecondsRaw = this.config?.pollSeconds ?? 30;
    const pollSeconds = Number(pollSecondsRaw);
    const bounded = Number.isFinite(pollSeconds) ? Math.min(300, Math.max(10, pollSeconds)) : 30;
    return bounded * 1000;
  }

  private getPythonPath(): string {
    return '/var/lib/homebridge/venv-kohler/bin/python';
  }

  private getScriptPath(): string {
    return '/var/lib/homebridge/rehlko_status.py';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private shouldRetryStatusFetch(err: unknown): boolean {
    const text = err instanceof Error ? err.message : String(err);
    const lowered = text.toLowerCase();
    return (
      lowered.includes('timeout') ||
      lowered.includes('communicationerror') ||
      lowered.includes('failed to get data after 0 retries') ||
      lowered.includes('econnreset') ||
      lowered.includes('etimedout') ||
      lowered.includes('eai_again')
    );
  }

  private summarizeStatusFetchError(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err);
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const usefulLine =
      lines.find((line) => line.startsWith('Failed to get data after')) ??
      lines.find((line) => line.toLowerCase().includes('timeout error')) ??
      lines[0] ??
      text;

    return usefulLine;
  }

  private async fetchStatus(): Promise<KohlerStatus> {
    const email = String(this.config?.email ?? '').trim();
    const password = String(this.config?.password ?? '').trim();

    if (!email || !password) {
      throw new Error('Missing email/password in Homebridge plugin config.');
    }

    const env = {
      ...process.env,
      KOH_EMAIL: email,
      KOH_PASS: password,
    };

    const { stdout } = await execFileAsync(this.getPythonPath(), [this.getScriptPath()], {
      env,
      timeout: 25_000,
    });

    const text = stdout.trim();
    if (!text) {
      throw new Error('Empty response from rehlko_status.py');
    }

    const parsed = JSON.parse(text) as KohlerStatus & { error?: string };
    if (parsed.error) {
      throw new Error(`rehlko_status.py error: ${parsed.error}`);
    }

    return parsed as KohlerStatus;
  }

  private async fetchStatusWithRetry(): Promise<KohlerStatus> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.fetchStatus();
      } catch (err) {
        const canRetry = attempt < maxAttempts && this.shouldRetryStatusFetch(err);
        if (!canRetry) {
          throw err;
        }

        if (this.config?.debug) {
          this.log.debug(`[Kohler Generator] Poll attempt ${attempt}/${maxAttempts} failed, retrying...`);
        }
        await this.sleep(1_500 * attempt);
      }
    }

    throw new Error('Unexpected status fetch retry flow');
  }

  discoverDevices() {
    // Stop any previous poll timer (in case Homebridge reloads the plugin)
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    // One accessory for the generator
    const displayName = String(this.config?.name ?? 'Kohler Generator');
    const uuid = this.api.hap.uuid.generate('kohler-generator-singleton-v2');
    let accessory: PlatformAccessory;

    const existingAccessory = this.accessories.get(uuid);
    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      accessory = existingAccessory;

      if (existingAccessory.displayName !== displayName) {
        existingAccessory.displayName = displayName;
      }
    } else {
      this.log.info('Adding new accessory:', displayName);
      accessory = new this.api.platformAccessory(displayName, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }

    // Create the accessory handler
    const handler = new ExamplePlatformAccessory(this, accessory);

    // Startup banner so you KNOW config is loaded
    const pollSeconds = Math.round(this.getPollMs() / 1000);
    this.log.info(`Polling every ${pollSeconds}s (debug=${Boolean(this.config?.debug)})`);
    const poll = async () => {
      if (this.pollInFlight) {
        if (this.config?.debug) {
          this.log.debug('[Kohler Generator] Poll skipped (previous poll still running)');
        }
        return;
      }

      this.pollInFlight = true;
      try {
        const status = await this.fetchStatusWithRetry();
        this.consecutivePollFailures = 0;

        handler.updateFromStatus(status);

        // Heartbeat line (shows even when debug=false)
        this.log.info(
          `Poll OK: engine=${status.engineState ?? 'n/a'} power=${status.powerSource ?? 'n/a'} ` +
  `alerts=${status.alertCount ?? 0} batt=${status.batteryVoltageV ?? 'n/a'}V util=${status.utilityVoltageV ?? 'n/a'}V`,
        );

        if (this.config?.debug) {
          this.log.debug('Kohler status raw:', JSON.stringify(status));
        }
      } catch (err) {
        this.consecutivePollFailures += 1;
        const msg = this.summarizeStatusFetchError(err);
        this.log.warn(
          `[Kohler Generator] Poll FAILED (x${this.consecutivePollFailures}): ${msg}`,
        );
        if (this.config?.debug) {
          this.log.debug(err as never);
        }
      } finally {
        this.pollInFlight = false;
      }
    };

    // Run immediately, then interval
    void poll();
    this.pollTimer = setInterval(() => void poll(), this.getPollMs());

    // Optional: clean up cache accessories we don't use anymore (we only have one)
    for (const [cachedUuid, cachedAccessory] of this.accessories) {
      if (cachedUuid !== uuid) {
        this.log.info('Removing stale accessory from cache:', cachedAccessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cachedAccessory]);
        this.accessories.delete(cachedUuid);
      }
    }
  }
}
