export type Lang = 'en' | 'hi';

const en = {
  app: 'CarbonKhata',
  tagline: 'Your stock registers, turned into a verified carbon ledger.',
  live: 'Live plant', energy: 'Energy & grid', credits: 'Carbon credits', brsr: 'BRSR report', parts: 'Part passports', today: 'Today', production: 'Production', meter: 'Meter photo', entry: 'Register entry', fuel: 'Fuel & gas', waste: 'Waste & scrap', more: 'More',
  dashboard: 'Dashboard', dq: 'Data quality', registers: 'Registers', close: 'Month close', exports: 'Reports & exports', savings: 'Savings', finance: 'Green finance', sharing: 'Sharing & consent', onboarding: 'Onboarding', settings: 'Settings',
  oemOverview: 'Supplier overview', oemProgramme: 'Programme', adminOverview: 'Overview', pipeline: 'Onboarding pipeline', dqCentre: 'Data-quality centre', factors: 'Libraries', billing: 'Billing & sponsors', audit: 'Audit & support',
  capture: 'Capture', review: 'Review', report: 'Report', share: 'Share', supplier: 'Supplier',
  hello: 'Good morning', tasksDue: 'Due today', quick: 'Quick actions',
  queued: 'entries waiting to sync', syncNow: 'Sync now', offline: 'You are offline. Entries are saved on this phone.', online: 'Online', goOffline: 'Simulate offline', goOnline: 'Back online',
  logProduction: 'Log production', howMany: 'How many bodies finished?', stage: 'Stage', date: 'Date', save: 'Save', saved: 'Saved', cancel: 'Cancel',
  takePhoto: 'Take or choose photo', aiRead: 'Reading found', confirm: 'Confirm', retake: 'Retake', confidence: 'Confidence',
  pickRegister: 'Register', received: 'Received', issued: 'Issued', quantity: 'Quantity', docRef: 'Challan / slip no.', usedFor: 'Used for',
  category: 'Category', disposal: 'Disposal route', vendor: 'Vendor',
  signIn: 'Sign in', phone: 'Mobile number', sendOtp: 'Send OTP', verify: 'Verify', language: 'Language', choosePersona: 'Demo: choose who you are',
  estimated: 'Estimated from activity data and standard factors',
  signOut: 'Sign out',
};
type Dict = typeof en;

const hi: Partial<Dict> = {
  tagline: 'आपके स्टॉक रजिस्टर, अब सत्यापित कार्बन खाता।',
  live: 'लाइव प्लांट', energy: 'ऊर्जा और ग्रिड', credits: 'कार्बन क्रेडिट', brsr: 'BRSR रिपोर्ट', parts: 'पार्ट पासपोर्ट', today: 'आज', production: 'उत्पादन', meter: 'मीटर फ़ोटो', entry: 'रजिस्टर एंट्री', fuel: 'ईंधन और गैस', waste: 'कचरा और स्क्रैप', more: 'और',
  dashboard: 'डैशबोर्ड', dq: 'डेटा गुणवत्ता', registers: 'रजिस्टर', close: 'महीना बंद', exports: 'रिपोर्ट और एक्सपोर्ट', savings: 'बचत', finance: 'ग्रीन फ़ाइनेंस', sharing: 'साझा और सहमति', onboarding: 'ऑनबोर्डिंग', settings: 'सेटिंग्स',
  capture: 'दर्ज करें', review: 'जाँच', report: 'रिपोर्ट', share: 'साझा',
  hello: 'सुप्रभात', tasksDue: 'आज के काम', quick: 'जल्दी के काम',
  queued: 'एंट्री सिंक होने का इंतज़ार कर रही हैं', syncNow: 'अभी सिंक करें', offline: 'आप ऑफ़लाइन हैं। एंट्री इसी फ़ोन में सुरक्षित हैं।', online: 'ऑनलाइन', goOffline: 'ऑफ़लाइन आज़माएँ', goOnline: 'वापस ऑनलाइन',
  logProduction: 'उत्पादन दर्ज करें', howMany: 'कितनी बॉडी पूरी हुईं?', stage: 'चरण', date: 'तारीख़', save: 'सेव करें', saved: 'सेव हो गया', cancel: 'रद्द करें',
  takePhoto: 'फ़ोटो लें या चुनें', aiRead: 'रीडिंग मिली', confirm: 'पक्का करें', retake: 'दोबारा लें', confidence: 'भरोसा',
  pickRegister: 'रजिस्टर', received: 'आया', issued: 'जारी हुआ', quantity: 'मात्रा', docRef: 'चालान / पर्ची नं.', usedFor: 'किस काम में',
  category: 'श्रेणी', disposal: 'निपटान', vendor: 'वेंडर',
  signIn: 'साइन इन', phone: 'मोबाइल नंबर', sendOtp: 'ओटीपी भेजें', verify: 'पुष्टि करें', language: 'भाषा', choosePersona: 'डेमो: आप कौन हैं चुनें',
  estimated: 'गतिविधि डेटा और मानक फ़ैक्टर से अनुमानित',
  signOut: 'साइन आउट',
};

export type TKey = keyof Dict;
export function translator(lang: Lang) {
  return (k: TKey) => (lang === 'hi' ? hi[k] ?? en[k] : en[k]);
}
