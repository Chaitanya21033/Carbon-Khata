"""Illustrative records for the OEM and admin views (port of reference/src/domain/samples.ts). All simulated."""
SAMPLE_SUPPLIERS = [
    {"id": "s1", "name": "Supplier A: pressings", "cluster": "Pune", "commodity": "Sheet-metal pressings", "stage": 10, "consent": "summary", "dq": 91, "intensity": 142, "trend": -6, "sample": True},
    {"id": "s2", "name": "Supplier B: castings", "cluster": "Jamshedpur", "commodity": "Grey-iron castings", "stage": 10, "consent": "detailed", "dq": 84, "intensity": 611, "trend": -3, "sample": True},
    {"id": "s3", "name": "Supplier C: wiring harness", "cluster": "Pantnagar", "commodity": "Wiring harness", "stage": 8, "consent": "summary", "dq": 76, "intensity": 38, "trend": 2, "sample": True},
    {"id": "s4", "name": "Supplier D: forgings", "cluster": "Jamshedpur", "commodity": "Axle forgings", "stage": 7, "consent": None, "dq": 58, "intensity": 0, "trend": 0, "sample": True},
    {"id": "s5", "name": "Supplier E: seating", "cluster": "Lucknow", "commodity": "Cabin seats", "stage": 5, "consent": None, "dq": 0, "intensity": 0, "trend": 0, "sample": True},
    {"id": "s6", "name": "Supplier F: fabrication", "cluster": "Dharwad", "commodity": "Load bodies", "stage": 10, "consent": "summary", "dq": 88, "intensity": 296, "trend": -9, "sample": True},
    {"id": "s7", "name": "Supplier G: paint shop", "cluster": "Pune", "commodity": "Contract painting", "stage": 3, "consent": None, "dq": 0, "intensity": 0, "trend": 0, "sample": True},
]
SAMPLE_CASES = [
    {"id": "c-demo", "supplier": "Vardhan Body Works", "cluster": "Jamshedpur", "sponsor": "OEM-sponsored", "associate": "Field team", "stage": 7, "daysInStage": 2, "daysTotal": 9, "sample": False},
    {"id": "c1", "supplier": "Supplier A: pressings", "cluster": "Pune", "sponsor": "OEM-sponsored", "associate": "Associate 1", "stage": 10, "daysInStage": 5, "daysTotal": 26, "sample": True},
    {"id": "c2", "supplier": "Supplier B: castings", "cluster": "Jamshedpur", "sponsor": "OEM-sponsored", "associate": "Associate 2", "stage": 11, "daysInStage": 12, "daysTotal": 64, "sample": True},
    {"id": "c3", "supplier": "Supplier C: wiring harness", "cluster": "Pantnagar", "sponsor": "Self-serve", "associate": "—", "stage": 8, "daysInStage": 1, "daysTotal": 11, "sample": True},
    {"id": "c4", "supplier": "Supplier D: forgings", "cluster": "Jamshedpur", "sponsor": "OEM-sponsored", "associate": "Associate 2", "stage": 7, "daysInStage": 9, "daysTotal": 17, "sample": True},
    {"id": "c5", "supplier": "Supplier E: seating", "cluster": "Lucknow", "sponsor": "Association", "associate": "Associate 3", "stage": 5, "daysInStage": 6, "daysTotal": 8, "sample": True},
    {"id": "c6", "supplier": "Supplier G: paint shop", "cluster": "Pune", "sponsor": "OEM-sponsored", "associate": "Associate 1", "stage": 3, "daysInStage": 4, "daysTotal": 5, "sample": True},
    {"id": "c7", "supplier": "Supplier H: rubber parts", "cluster": "Chennai", "sponsor": "OEM-sponsored", "associate": "—", "stage": 1, "daysInStage": 0, "daysTotal": 0, "sample": True},
    {"id": "c8", "supplier": "Supplier I: fasteners", "cluster": "Ludhiana", "sponsor": "Self-serve", "associate": "—", "stage": 2, "daysInStage": 3, "daysTotal": 3, "sample": True},
    {"id": "c9", "supplier": "Supplier J: machining", "cluster": "Rajkot", "sponsor": "Association", "associate": "Associate 3", "stage": 6, "daysInStage": 11, "daysTotal": 19, "sample": True},
]
