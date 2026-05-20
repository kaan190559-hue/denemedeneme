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
      "Beritan Yıldız": [["Halk", 733], ["Yapı", 130], ["Finans", 36]],
      "Büşra Kaya": [["Ziraat", 730], ["Deniz", 518], ["Garanti", 742], ["Vakıf", 850]],
      "Şilan Akıcı": [["Finans", 37], ["Garanti", 516], ["Yapı", 243], ["Vakıf", 219], ["Ziraat", 583]],
      "Ahmet Kahraman": [["Halk", 254], ["Ziraat", 882], ["Vakıf", 266], ["Finans", 833], ["Yapı", 712], ["TOM", 507], ["Kuveyt", 865], ["TEB", 118]]
    }
  },
  aslan: {
    title: "Aslan Bozok Kasa",
    accent: "blue",
    sets: {
      "Samet Alp Yurddaş": [["Halk", 0], ["Akbank", 0], ["Kuveyt", 0], ["Deniz", 75682], ["Yapı Kredi", 6143], ["Enpara", 79223], ["QNB Finans", 106164], ["VakıfBank", 33577]],
      "Mürsel Yıldız": [["Deniz", 1078], ["Garanti", 665], ["Akbank", 0], ["Enpara", 5372], ["Kuveyt", 23], ["Halk", 0], ["ING", 2106], ["TEB", 1362], ["VakıfBank", 1030]],
      "Halil Yıldız": [["Yapı Kredi", 0], ["QNB Finans", 60140], ["Garanti", 67864], ["Deniz", 52232], ["Ziraat", 47783]],
      "Yiğit Aras": [["Enpara", 712], ["ING", 115], ["Kuveyt", 424], ["Halk", 272], ["Akbank", 93], ["Garanti", 94]],
      "Sıla Selcan": [["ING", 0], ["Akbank", 200], ["Halk", 2463], ["Yapı", 2854], ["QNB Finans", 1206], ["Deniz", 887]]
    }
  },
  ares: {
    title: "Ares Bozok Kasa",
    accent: "cyan",
    sets: {
      "Beritan Bacaru": [["YapıKredi", 650], ["Deniz", 1561], ["QNB Finans", 280]],
      "Yeşim Rodoplu": [["Deniz", 881], ["Garanti", 53], ["YapıKredi", 572], ["Kuveyt", 677], ["Enpara", 1090], ["ING", 785]],
      "Sercan Kesgin": [["Akbank", 14000], ["Garanti", 8000], ["Vakıf", 28000], ["YapıKredi", 19000], ["Enpara", 16000], ["Deniz", 26000], ["ING", 31250], ["Kuveyt", 20000], ["Hadi Bank", 24500]]
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
    theme: "aurora",
    sectionVersions: {
      vaults: now,
      report: 0,
      reconciliation: now,
      blockRows: 0,
      commissionHistory: 0,
      theme: 0
    }
  };
}

module.exports = { createDefaultDashboardState, defaultVaults, defaultReconciliationRows };
