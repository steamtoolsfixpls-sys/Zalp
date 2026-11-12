// Vehicle part split for the asset pipeline. Filled in per vehicle; a missing config is a no-op.
export const VEHICLE_RIGS = {};

export async function rigVehicle(doc, key) {
    const cfg = VEHICLE_RIGS[key];
    if (!cfg) return;
    await cfg(doc);
}
