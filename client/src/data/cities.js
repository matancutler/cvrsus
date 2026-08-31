/**
 * The cities the City field offers.
 *
 * Suggestions, not a constraint. The field stays free text and always has: a
 * candidate in Berlin or Limassol has to be able to say so, and a list that
 * refuses them is a list that loses them. What this buys is the common case —
 * most people here live in one of these, and picking beats typing.
 *
 * Israel's municipalities and the local councils people actually name when
 * asked where they live. Not every village: a list long enough to scroll past
 * is a list nobody reads, and anything missing can still be typed.
 *
 * ONE SPELLING EACH. "Tel Aviv" and "Beer Sheva" are not entries — matchCities
 * folds case, punctuation and spacing before comparing, so both find their
 * canonical name. Adding variants would show the same place twice and make the
 * list longer for no one's benefit.
 *
 * Sorted here so the file is the order, and nothing has to sort at render time.
 */
export const CITIES = [
  'Acre',
  'Afula',
  'Arad',
  'Ariel',
  'Arraba',
  'Ashdod',
  'Ashkelon',
  'Atlit',
  'Azor',
  'Baqa al-Gharbiyye',
  'Bat Yam',
  'Be\'er Sheva',
  'Beit Shean',
  'Beit Shemesh',
  'Beitar Illit',
  'Binyamina-Givat Ada',
  'Bnei Brak',
  'Caesarea',
  'Daliyat al-Karmel',
  'Dimona',
  'Efrat',
  'Eilat',
  'Elad',
  'Elkana',
  'Even Yehuda',
  'Fureidis',
  'Gan Yavne',
  'Ganei Tikva',
  'Gedera',
  'Giv\'at Shmuel',
  'Givatayim',
  'Hadera',
  'Haifa',
  'Har Adar',
  'Hatzor HaGlilit',
  'Herzliya',
  'Hod HaSharon',
  'Holon',
  'Isfiya',
  'Jaljulia',
  'Jerusalem',
  'Jisr az-Zarqa',
  'Judeida-Makr',
  'Kadima-Zoran',
  'Kafr Bara',
  'Kafr Kanna',
  'Kafr Manda',
  'Kafr Qasim',
  'Kafr Yasif',
  'Karmiel',
  'Kfar Kama',
  'Kfar Saba',
  'Kfar Shmaryahu',
  'Kfar Tavor',
  'Kfar Vradim',
  'Kfar Yona',
  'Kiryat Ata',
  'Kiryat Bialik',
  'Kiryat Ekron',
  'Kiryat Gat',
  'Kiryat Malakhi',
  'Kiryat Motzkin',
  'Kiryat Ono',
  'Kiryat Shmona',
  'Kiryat Tivon',
  'Kiryat Yam',
  'Kochav Yair-Tzur Yigal',
  'Lehavim',
  'Lod',
  'Ma\'ale Adumim',
  'Ma\'alot-Tarshiha',
  'Maghar',
  'Mazkeret Batya',
  'Meitar',
  'Metula',
  'Migdal HaEmek',
  'Mitzpe Ramon',
  'Modi\'in Illit',
  'Modi\'in-Maccabim-Re\'ut',
  'Nahariya',
  'Nazareth',
  'Nes Ziona',
  'Nesher',
  'Netanya',
  'Netivot',
  'Nof HaGalil',
  'Ofakim',
  'Omer',
  'Or Akiva',
  'Or Yehuda',
  'Oranit',
  'Pardes Hanna-Karkur',
  'Petah Tikva',
  'Qalansawe',
  'Ra\'anana',
  'Rahat',
  'Ramat Gan',
  'Ramat HaSharon',
  'Ramat Yishai',
  'Ramla',
  'Rehovot',
  'Reineh',
  'Rishon LeZion',
  'Rosh HaAyin',
  'Rosh Pina',
  'Safed',
  'Sakhnin',
  'Savyon',
  'Sderot',
  'Shefaram',
  'Shoham',
  'Tamra',
  'Tayibe',
  'Tel Aviv-Yafo',
  'Tiberias',
  'Tira',
  'Tirat Carmel',
  'Tur\'an',
  'Umm al-Fahm',
  'Yavne',
  'Yehud-Monosson',
  'Yeruham',
  'Yirka',
  'Yokneam Illit',
  'Zichron Ya\'akov',
]

/** Case, punctuation and spacing removed — "Be'er Sheva" and "beersheva" meet here. */
export function cityKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The cities to offer for what has been typed so far.
 *
 * An empty query is not "no matches" — it is the whole list, which is what
 * clicking the field asks for.
 *
 * Names that START with what was typed come first: somebody four characters
 * into "Ram" means Ramla or Ramat Gan long before they mean Kfar Kama. Within
 * each half the file order stands, so the list never reshuffles under them.
 */
export function matchCities(query) {
  const key = cityKey(query)
  if (!key) return CITIES

  const starts = []
  const contains = []
  for (const city of CITIES) {
    const candidate = cityKey(city)
    if (candidate.startsWith(key)) starts.push(city)
    else if (candidate.includes(key)) contains.push(city)
  }
  return [...starts, ...contains]
}
