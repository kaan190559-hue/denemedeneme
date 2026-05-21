const defaultVaults = {
  atlas: {
    title: "Atlas Bozok Kasa",
    accent: "green",
    sets: {
      "Emre Can Akıcı": [["Enpara", 6410], ["QNB Finans", 2104], ["Garanti", 0]],
      "Muhammed Sadi Akar": [["Garanti", 401], ["YapıKredi", 811], ["ING", 3104], ["QNB Finans", 168]],
      "Berivan Yıldız": [["Ziraat", 711], ["Deniz", 3691], ["Vakıf", 440], ["YapıKredi", 0], ["ING", 5510], ["Garanti", 100]],
      "Keziban Doğan": [["QNB Finans", 3168], ["Enpara", 5], ["YapıKredi", 4866], ["TOM", 3000], ["Akbank", 6466], ["TEB", 400], ["ING", 500], ["Kuveyt", 1], ["Ziraat", 676]]
    }
  },
  ecem: {
    title: "Ecem Bozok Kasa",
    accent: "red",
    sets: {
      "Beritan Yıldız": [["Halkbank", 733], ["Yapı Kredi", 130], ["QNB Finansbank", 36]],
      "Büşra Kaya": [["Ziraat Bankası", 730], ["DenizBank", 518], ["Garanti BBVA", 742], ["VakıfBank", 850]],
      "Şilan Akıcı": [["QNB Finansbank", 37], ["Garanti BBVA", 516], ["Yapı Kredi", 243], ["VakıfBank", 219], ["Ziraat Bankası", 583]],
      "Ahmet Kahraman": [["Halkbank", 254], ["Ziraat Bankası", 882], ["VakıfBank", 266], ["QNB Finansbank", 833], ["Yapı Kredi", 712], ["TOM", 507], ["Kuveyt Türk", 865], ["TEB", 118]]
    }
  },
  aslan: {
    title: "Aslan Bozok Kasa",
    accent: "blue",
    sets: {
      "Samet Alp Yurddaş": [["Halkbank", 0], ["Akbank", 0], ["Kuveyt Türk", 0], ["DenizBank", 1682], ["Yapı Kredi", 1143], ["Enpara", 223], ["QNB Finansbank", 2164], ["VakıfBank", 2577]],
      "Mürsel Yıldız": [["DenizBank", 78], ["Garanti BBVA", 665], ["Akbank", 0], ["Enpara", 372], ["Kuveyt Türk", 23], ["Halkbank", 0], ["ING", 106], ["TEB", 362], ["VakıfBank", 30]],
      "Halil Yıldız": [["Yapı Kredi", 0], ["QNB Finansbank", 130], ["Garanti BBVA", 1864], ["DenizBank", 232], ["Ziraat Bankası", 9783]],
      "Yiğit Aras": [["Enpara", 712], ["ING", 115], ["Kuveyt Türk", 1424], ["Halkbank", 272], ["Akbank", 93], ["Garanti BBVA", 94]],
      "Sıla Selcan": [["ING", 0], ["Akbank", 200], ["Halkbank", 63], ["Yapı Kredi", 54], ["QNB Finansbank", 206], ["DenizBank", 887]]
    }
  },
  ares: {
    title: "Ares Bozok Kasa",
    accent: "cyan",
    sets: {
      "Beritan Bacaru": [["Yapı Kredi", 650], ["DenizBank", 1561], ["QNB Finansbank", 280]],
      "Yeşim Rodoplu": [["DenizBank", 881], ["Garanti BBVA", 53], ["Yapı Kredi", 572], ["Kuveyt Türk", 677], ["Enpara", 90], ["ING", 6785]],
      "Sercan Kesgin": [["Akbank", 0], ["Garanti BBVA", 0], ["VakıfBank", 2100], ["Yapı Kredi", 2130], ["Enpara", 43000], ["DenizBank", 0], ["ING", 250], ["Kuveyt Türk", 0], ["Hadi", 500]]
    }
  }
};

const defaultReconciliationRows = [
  { label: "Panel Kasa", group: "gider", gelir: 0, kasa: 0, devir: 0, auto: { kasa: "reportKasa" } },
  { label: "Personel Ödemesi", group: "gider", gelir: 0, kasa: 0, devir: 0 },
  { label: "Ares Kasa", group: "gider", gelir: 0, kasa: 0, devir: 0, auto: { gelir: "vault:ares" } },
  { label: "Ecem Kasa", group: "gider", gelir: 0, kasa: 0, devir: 0, auto: { gelir: "vault:ecem" } },
  { label: "Aslan Kasa", group: "gider", gelir: 0, kasa: 0, devir: 0, auto: { gelir: "vault:aslan" } },
  { label: "Atlas Kasa", group: "gider", gelir: 0, kasa: 0, devir: 0, auto: { gelir: "vault:atlas" } },
  { label: "Komisyon Tutarı", group: "borc", gelir: 0, kasa: 0, devir: 0, auto: { devir: "reportKomisyon" } },
  { label: "Set Ödemesi Tutarı", group: "gider", gelir: 0, kasa: 0, devir: 0 },
  { label: "Bloke Tutarı", group: "gider", gelir: 0, kasa: 0, devir: 0 },
  { label: "Dünün Borcu", group: "borcDusum", gelir: 0, kasa: 0, devir: 0 },
  { label: "Dünün Alacağı", group: "alacak", gelir: 0, kasa: 0, devir: 0 },
  { label: "Elif Abla Ödeme", group: "gider", gelir: 0, kasa: 0, devir: 0 },
  { label: "Cemal Abi Ödeme", group: "gider", gelir: 0, kasa: 0, devir: 0 }
];

function createDefaultDashboardState() {
  const now = Date.now();
  return {
    updatedAt: now,
    savedAt: new Date(now).toISOString(),
    actor: "Fallback",
    vaults: JSON.parse(JSON.stringify(defaultVaults)),
    latestReport: null,
    reconciliationRows: JSON.parse(JSON.stringify(defaultReconciliationRows)),
    blockRows: [],
    commissionHistory: [],
    dayClosed: null,
    theme: "aurora",
    sectionVersions: {
      vaults: now,
      report: 0,
      reconciliation: now,
      blockRows: 0,
      commissionHistory: 0,
      dayClosed: 0,
      theme: 0
    }
  };
}

module.exports = { createDefaultDashboardState, defaultVaults, defaultReconciliationRows };
