"""Field devices of the demo plant: what each one measures and whether its reading can be overridden from its own page."""
SENSORS = [
    # id, label, unit, kind, overridable, what it is
    ("incomer", "Main incomer (HT)", "kW", "energy", False, "DLMS smart meter at the 11 kV incomer: grid import, kVA, PF"),
    ("comp", "Compressor", "kW", "energy", True, "Sub-meter on the screw compressor"),
    ("weld", "Welding bay", "kW", "energy", True, "Sub-meter on the welding bay distribution board"),
    ("paint", "Paint shop & oven", "kW", "energy", True, "Sub-meter on the paint booth and curing oven"),
    ("light", "Lighting", "kW", "energy", True, "Sub-meter on the lighting feeders"),
    ("util", "Utilities & office", "kW", "energy", True, "Sub-meter on utilities, pumps and office"),
    ("solar", "Rooftop solar inverter", "kW", "energy", True, "250 kWp inverter, AC output"),
    ("bess", "Battery (BMS)", "%", "energy", True, "400 kWh / 150 kW battery, state of charge"),
    ("genset", "Gas genset controller", "kW", "energy", False, "150 kW natural-gas genset, electrical output"),
    ("co2_stack", "Genset stack CO₂ analyser", "kg/h", "carbon", True, "NDIR analyser on the genset exhaust stack (CO₂ mass flow)"),
    ("co2_flue", "Paint-oven flue CO₂ analyser", "kg/h", "carbon", True, "NDIR analyser on the LPG burner flue of the curing oven"),
    ("co2_air", "Welding-bay air CO₂ monitor", "ppm", "carbon", True, "Ambient CO₂ in the welding bay (shielding-gas release, ventilation check)"),
]
BY_ID = {s[0]: s for s in SENSORS}
