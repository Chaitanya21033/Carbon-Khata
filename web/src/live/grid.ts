// Market / EMS constants and helpers for display. The market model, dispatch and accounting run in the API.
// 1) A simulated feed shaped like the Indian Energy Exchange (IEX) market: 96 fifteen-minute blocks a day,
//    day-ahead (DAM), green day-ahead (G-DAM) and real-time (RTM) prices, plus a regional grid "duck curve"
//    and a time-of-day marginal emission factor. In production this class is swapped for a licensed
//    market-data adapter; everything downstream only reads `MarketBlock`.
// 2) A dispatch engine (EMS) that decides every 15 minutes: buy from which category, charge / discharge the
//    battery, run the gas genset, shift flexible loads, export to the grid, or shed load for a grid event.

export const BLOCKS = 96;
export const PRICE_CAP = 10; // ₹/kWh, exchange price ceiling (illustrative)

export interface MarketBlock {
  block: number;           // 0..95
  dam: number;             // ₹/kWh day-ahead clearing price
  gdam: number;            // ₹/kWh green day-ahead
  rtm: number;             // ₹/kWh real-time clearing price
  discom: number;          // ₹/kWh DISCOM time-of-day tariff (energy charge)
  gridDemandGW: number;    // regional demand
  solarGW: number;         // regional solar
  netDemandGW: number;     // demand − solar (the duck curve)
  marginalEf: number;      // kg CO₂/kWh, time-of-day marginal (illustrative)
  stress: number;          // 0–100 grid stress index
}

/** Open-access landed adders on top of exchange price (wheeling, transmission, surcharges). Illustrative. */
export const OA_ADDER = { grey: 1.7, green: 1.1 };
export const CEA_EF = 0.71;        // kg/kWh, location-based (CEA average)
export const GENSET_EF = 0.61;     // kg/kWh, natural-gas genset (≈ 2.02 kg/scm ÷ 3.3 kWh/scm)
export const GENSET_KWH_PER_SCM = 3.3;
export const GENSET_FUEL_INR = 5.6; // ₹/kWh fuel cost
export const IMPORT_CAP_KW = 380;  // keep 15-min demand under the 450 kVA contract
export const EXPORT_CAP_KW = 220;

export const SOURCES = ['solar', 'bess', 'genset', 'green', 'rtm', 'dam', 'discom'] as const;
export type Source = typeof SOURCES[number];
export const SOURCE_LABEL: Record<Source, string> = { solar: 'Rooftop solar', bess: 'Battery', genset: 'Gas genset (CHP)', green: 'Green power (G-DAM)', rtm: 'Exchange real-time (RTM)', dam: 'Exchange day-ahead (DAM)', discom: 'DISCOM tariff' };
export const SOURCE_COLOR: Record<Source, string> = { solar: '#F2C14E', bess: '#7C5CFF', genset: '#E8743B', green: '#3FBF7F', rtm: '#4C9BE8', dam: '#2EC4B6', discom: '#8A979F' };


export function discomTod(h: number) {
  const base = 7.0;
  if (h >= 9 && h < 17) return +(base * 0.8).toFixed(2);  // solar hours: at least 20% lower
  if (h >= 18 && h < 22) return +(base * 1.2).toFixed(2); // peak hours: at least 20% higher
  return base;
}

export const landed = (b: MarketBlock) => ({
  discom: b.discom,
  rtm: b.rtm + OA_ADDER.grey,
  dam: b.dam + OA_ADDER.grey,
  green: b.gdam + OA_ADDER.green,
});

