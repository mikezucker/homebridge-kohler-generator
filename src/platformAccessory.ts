import type { Characteristic, PlatformAccessory, Service } from 'homebridge';
import type { WithUUID } from 'hap-nodejs';

import type { KohlerGeneratorPlatform, KohlerStatus } from './platform.js';

type EveServiceCtor = WithUUID<typeof Service>;
type EveCharacteristicCtor = WithUUID<new () => Characteristic>;

type EveServices = {
  VoltageSensor: EveServiceCtor;
};

type EveCharacteristics = {
  Voltage: EveCharacteristicCtor;
};

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function voltageToPercent(v: number): number {
  // rough lead-acid-ish mapping
  const V_EMPTY = 11.8;
  const V_FULL = 13.6;
  const pct = ((v - V_EMPTY) / (V_FULL - V_EMPTY)) * 100;
  return Math.round(clamp(pct, 0, 100));
}

function isLowBattery(v: number): boolean {
  return v < 12.0;
}

export class ExamplePlatformAccessory {
  private runningService: Service;
  private exerciseRunningService: Service;
  private outageRunningService: Service;
  private faultService: Service;
  private utilityService: Service;

  private batteryService: Service;
  private utilityVoltageService: Service;

  private eveServices: EveServices;
  private eveChars: EveCharacteristics;

  constructor(
    private readonly platform: KohlerGeneratorPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // Eve types come from platform.ts (EveHomeKitTypes)
    this.eveServices = this.platform.CustomServices as unknown as EveServices;
    this.eveChars = this.platform.CustomCharacteristics as unknown as EveCharacteristics;

    // Accessory Information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Kohler / Rehlko')
      .setCharacteristic(this.platform.Characteristic.Model, 'Generator')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Unknown');

    // Tile 1: Running (ContactSensor so notifications are opened/closed instead of motion)
    this.runningService = this.getOrReplaceRunningService('Generator On', 'kohler-running');
    this.exerciseRunningService = this.getOrReplaceContactService('Generator Exercise On', 'kohler-running-test');
    this.outageRunningService = this.getOrReplaceContactService('Generator Outage On', 'kohler-running-outage');

    // Tile 2: Fault (ContactSensor: NOT detected = fault)
    this.faultService =
      this.accessory.getService('Generator Fault') ??
      this.accessory.addService(this.platform.Service.ContactSensor, 'Generator Fault', 'kohler-fault');

    // Tile 3: Utility Power Present (OccupancySensor)
    this.utilityService =
      this.accessory.getService('Utility Power Present') ??
      this.accessory.addService(this.platform.Service.OccupancySensor, 'Utility Power Present', 'kohler-utility');

    // Tile 4: Battery (native HomeKit BatteryService)
    this.batteryService = this.getOrReplaceBatteryService('Battery', 'kohler-battery');

    // Tile 5: Utility Voltage (Eve VoltageSensor)
    this.utilityVoltageService = this.getOrReplaceEveVoltageService('Utility Voltage', 'kohler-util-v');

    // If you previously created these, delete them so they don’t keep haunting you
    this.removeLegacyNamedServiceIfPresent('Battery Voltage');

    // Defaults so Home doesn’t show stale junk on boot
    this.runningService.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
    this.exerciseRunningService.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
    this.outageRunningService.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );

    this.faultService.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );

    this.utilityService.updateCharacteristic(
      this.platform.Characteristic.OccupancyDetected,
      this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );

    this.batteryService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, 100);
    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.StatusLowBattery,
      this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.ChargingState,
      this.platform.Characteristic.ChargingState.NOT_CHARGING,
    );

    // Eve Voltage default
    this.utilityVoltageService.getCharacteristic(this.eveChars.Voltage).updateValue(0);
  }

  private removeLegacyNamedServiceIfPresent(name: string) {
    const svc = this.accessory.getService(name) as Service | undefined;
    if (svc) {
      this.platform.log.warn(`[${this.accessory.displayName}] Removing legacy service "${name}" (${svc.UUID})`);
      this.accessory.removeService(svc);
    }
  }

  private getOrReplaceBatteryService(name: string, subtype: string): Service {
    let svc = this.accessory.getServiceById(this.platform.Service.Battery, subtype) as Service | undefined;

    if (!svc) {
      svc = this.accessory.getService(name) as Service | undefined;
    }

    if (svc && svc.UUID !== this.platform.Service.Battery.UUID) {
      this.platform.log.warn(
        `[${this.accessory.displayName}] Replacing legacy "${name}" (${svc.UUID}) with BatteryService.`,
      );
      this.accessory.removeService(svc);
      svc = undefined;
    }

    if (!svc) {
      svc = this.accessory.addService(this.platform.Service.Battery, name, subtype);
    }

    return svc;
  }

  private getOrReplaceRunningService(name: string, subtype: string): Service {
    return this.getOrReplaceContactService(name, subtype);
  }

  private getOrReplaceContactService(name: string, subtype: string): Service {
    let svc = this.accessory.getServiceById(this.platform.Service.ContactSensor, subtype) as Service | undefined;

    if (!svc) {
      svc = this.accessory.getService(name) as Service | undefined;
    }

    if (svc && svc.UUID !== this.platform.Service.ContactSensor.UUID) {
      this.platform.log.warn(
        `[${this.accessory.displayName}] Replacing legacy "${name}" (${svc.UUID}) with ContactSensor.`,
      );
      this.accessory.removeService(svc);
      svc = undefined;
    }

    if (!svc) {
      svc = this.accessory.addService(this.platform.Service.ContactSensor, name, subtype);
    }

    return svc;
  }

  private getOrReplaceEveVoltageService(name: string, subtype: string): Service {
    const EveVoltage = this.eveServices.VoltageSensor; // typed WithUUID<typeof Service>

    // Prefer subtype lookup (stable)
    let svc = this.accessory.getServiceById(EveVoltage, subtype) as Service | undefined;

    // Fallback by name
    if (!svc) {
      svc = this.accessory.getService(name) as Service | undefined;
    }

    // If it exists but is NOT Eve VoltageSensor, nuke it and rebuild
    if (svc && svc.UUID !== EveVoltage.UUID) {
      this.platform.log.warn(
        `[${this.accessory.displayName}] Replacing legacy "${name}" (${svc.UUID}) with Eve VoltageSensor (${EveVoltage.UUID}).`,
      );
      this.accessory.removeService(svc);
      svc = undefined;
    }

    if (!svc) {
      svc = this.accessory.addService(EveVoltage, name, subtype);
    }

    // Ensure the Voltage characteristic exists
    svc.getCharacteristic(this.eveChars.Voltage);

    return svc;
  }

  updateFromStatus(status: KohlerStatus) {
    const engineStateRaw = String(status.engineState ?? '').trim();
    const powerSourceRaw = String(status.powerSource ?? '').trim();
    const alertCount = Number(status.alertCount ?? 0);

    const engineState = engineStateRaw.toLowerCase();
    const powerSource = powerSourceRaw.toLowerCase();

    const isRunning =
      engineState !== '' &&
      engineState !== 'standby' &&
      engineState !== 'readytorun' &&
      engineState !== 'ready to run';

    const utilityPresent = powerSource === 'utility';
    const hasFault = alertCount > 0;

    const batteryVoltageV = typeof status.batteryVoltageV === 'number' ? status.batteryVoltageV : undefined;
    const utilityVoltageV = typeof status.utilityVoltageV === 'number' ? status.utilityVoltageV : undefined;
    const utilityLikelyPresent = utilityPresent || (utilityVoltageV !== undefined && utilityVoltageV >= 180);
    const isExerciseRunning = isRunning && utilityLikelyPresent;
    const isOutageRunning = isRunning && !utilityLikelyPresent;

    this.accessory.context.kohler = {
      ...(this.accessory.context.kohler ?? {}),
      isRunning,
      isExerciseRunning,
      isOutageRunning,
      utilityPresent,
      hasFault,
      batteryVoltageV,
      utilityVoltageV,
      lastStatus: status,
    };

    this.runningService.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      isRunning
        ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
    this.exerciseRunningService.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      isExerciseRunning
        ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
    this.outageRunningService.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      isOutageRunning
        ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );

    this.faultService.updateCharacteristic(
      this.platform.Characteristic.ContactSensorState,
      hasFault
        ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );

    this.utilityService.updateCharacteristic(
      this.platform.Characteristic.OccupancyDetected,
      utilityPresent
        ? this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );

    if (batteryVoltageV !== undefined) {
      const pct = voltageToPercent(batteryVoltageV);

      this.batteryService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, pct);
      this.batteryService.updateCharacteristic(
        this.platform.Characteristic.StatusLowBattery,
        isLowBattery(batteryVoltageV)
          ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
      this.batteryService.updateCharacteristic(
        this.platform.Characteristic.ChargingState,
        this.platform.Characteristic.ChargingState.NOT_CHARGING,
      );
    }

    if (utilityVoltageV !== undefined) {
      this.utilityVoltageService.getCharacteristic(this.eveChars.Voltage).updateValue(utilityVoltageV);
    }

    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Kohler / Rehlko')
      .setCharacteristic(this.platform.Characteristic.Model, status.controllerType ?? 'Generator')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, String(status.deviceId ?? 'Unknown'));

    const baseName = status.name ?? this.accessory.displayName;
    this.runningService.setCharacteristic(this.platform.Characteristic.Name, `${baseName} On`);
    this.exerciseRunningService.setCharacteristic(this.platform.Characteristic.Name, `${baseName} Exercise On`);
    this.outageRunningService.setCharacteristic(this.platform.Characteristic.Name, `${baseName} Outage On`);
    this.faultService.setCharacteristic(this.platform.Characteristic.Name, `${baseName} Fault`);
    this.utilityService.setCharacteristic(this.platform.Characteristic.Name, `${baseName} Utility Power`);
    this.batteryService.setCharacteristic(this.platform.Characteristic.Name, `${baseName} Battery`);
    this.utilityVoltageService.setCharacteristic(this.platform.Characteristic.Name, `${baseName} Utility Voltage`);
  }
}
