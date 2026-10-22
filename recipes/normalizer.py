"""Offline ingredient normalization. No model/API calls; original text is retained."""
import functools
import re
import unicodedata
from pathlib import Path

import pymorphy3

ROOT = Path(__file__).resolve().parent
MORPH = pymorphy3.MorphAnalyzer()


def clean(text):
    text = unicodedata.normalize('NFKC', str(text or '')).lower().replace('ё', 'е')
    return re.sub(r'\s+', ' ', text.replace('\xa0', ' ')).strip()


@functools.lru_cache(maxsize=100000)
def lemma(word):
    return MORPH.parse(word)[0].normal_form if re.fullmatch('[а-я]+', word) else word


@functools.lru_cache(maxsize=150000)
def ru_key(text):
    # Sorting makes "лук репчатый" and "репчатый лук" equivalent.
    return ' '.join(sorted(lemma(w) for w in re.findall(r'[а-яa-z]+', clean(text))))


def en_key(text):
    return re.sub(r'[^a-z0-9]+', ' ', clean(text)).strip()


def load_glossary(path=ROOT / 'glossary.tsv'):
    rows, ru_alias, en_alias = [], {}, {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        name, rus, ens = line.split('|')
        row = {'name': name, 'ru': [name] + [x for x in rus.split(';') if x],
               'en': [x for x in ens.split(';') if x]}
        rows.append(row)
        for alias in row['ru']:
            key = ru_key(alias)
            if key in ru_alias and ru_alias[key] != name:
                raise ValueError('Ambiguous Russian alias: ' + alias)
            ru_alias[key] = name
        for alias in row['en']:
            key = en_key(alias)
            if key in en_alias and en_alias[key] != name:
                raise ValueError('Ambiguous English alias: ' + alias)
            en_alias[key] = name
    return rows, ru_alias, en_alias


RU_NOISE = set('свежий свежемороженый замороженный охлажденный мытый очищенный '
               'крупный мелкий средний небольшой спелый натертый тертый рубленый '
               'нарезанный измельченный просеянный молотый дробленый без косточка '
               'кожица кожура стебель лист пучок зубчик головка крупно мелко '
               'толченый отборный обычный комнатный температура среднее размер '
               'холодный теплый горячий питьевой рафинированный размягченный '
               'свежемолотый жирность жидкий дезодорированный'.split())
RU_NOISE = set(lemma(x) for x in RU_NOISE)


@functools.lru_cache(maxsize=180000)
def ru_name(raw):
    s = clean(raw).lstrip(' -*•–—\ufeff')
    if not re.search('[а-яa-z]', s) or s.startswith(('для ', 'на ваш ', 'по вкус')):
        return ''
    if s.endswith(':'):
        return ''
    s = re.sub(r'^\d[\d\s.,/⁄–-]*', '', s)
    s = re.sub(r'^(?:кг|г|мл|л|шт\.?|ст\.?|ч\.?)\s+', '', s)
    # Preserve meaningful compound names, but cut off quantity/usage notes.
    s = re.split(r'\s+[—–-]\s+|\s*[–—]\s*(?=\d|по вкус)', s, maxsplit=1)[0]
    s = re.sub(r'\([^)]*\)', ' ', s)
    s = re.split(r'\b(?:для|по вкусу|по желанию|по необходимости|при необходимости)\b', s)[0]
    s = re.sub(r'\b\d[\d\s.,/–-]*(?:%|грамм\w*|кг|мл|литр\w*|г|л|шт\w*|ст\w*|ч\w*|лож\w*|пуч\w*)?.*$', '', s)
    s = re.sub(r'^(?:немного|несколько|примерно|около|щепотка|щепоть|горсть)\s+', '', s)
    return s.strip(' .,;:*+-–—')


EN_UNITS = re.compile(r'\b(?:cups?|c|tablespoons?|tbsp|tbs|tbl|teaspoons?|tsp|ts|ounces?|oz|pounds?|lbs?|lb|grams?|g|kilograms?|kg|milliliters?|ml|liters?|litres?|l|packages?|pkgs?|pkg|packets?|cans?|jars?|bottles?|cartons?|sticks?|slices?|bunch(?:es)?|handfuls?|pinch|pinches|dash|dashes|qt|quarts?|pt|pints?|gallons?|stalks?|ribs?|heads?|box(?:es)?|containers?|tubs?|envelopes?|squares?|sq|strips?|sprigs?)\b\.?')
EN_PREP = re.compile(r'\b(?:firmly|loosely|lightly|tightly|packed|chopped|diced|minced|sliced|grated|shredded|cubed|melted|softened|sifted|beaten|divided|thawed|drained|rinsed|peeled|seeded|deveined|pitted|crushed|coarsely|finely|thinly|roughly|freshly|large|medium|small|extra large|extra-large|room temperature|at room temperature|to taste|as needed|optional|about|approximately|heaping|heaped|level|scant|inch|inches|cut up)\b')


@functools.lru_cache(maxsize=180000)
def en_base(raw):
    s = clean(raw)
    s = re.sub(r'\([^)]*\)', ' ', s)
    # A comma may separate ingredients ("salt, pepper"), not only preparation.
    s = re.split(r',\s*(?=(?:well\s+)?(?:chopped|diced|minced|sliced|grated|shredded|cubed|melted|softened|sifted|beaten|divided|thawed|drained|rinsed|peeled|seeded|deveined|pitted|crushed|cut|to taste|at room|room temperature|plus more|optional|for garnish|for serving)\b)', s, maxsplit=1)[0]
    s = re.split(r'\b(?:for serving|for garnish|for dusting|for frying|plus more|such as|to serve)\b', s)[0]
    s = re.sub(r'\d+(?:[.,/]\d+)?', ' ', s)
    s = EN_UNITS.sub(' ', s)
    s = re.sub(r'^\s*(?:of|a|an|the|to)\s+', '', s)
    return en_key(s)


@functools.lru_cache(maxsize=180000)
def en_name(raw):
    s = en_base(raw)
    s = EN_PREP.sub(' ', s)
    s = re.sub(r'^\s*(?:of|a|an|the)\s+', '', s)
    s = re.sub(r'\b(?:well|very)\b', '', s)
    return en_key(s)


class Normalizer:
    def __init__(self):
        self.rows, self.ru_alias, self.en_alias = load_glossary()

    @functools.lru_cache(maxsize=200000)
    def resolve(self, raw, language):
        """Return a stable key, display label, localization flag; never discard unknowns."""
        if language == 'ru':
            text = ru_name(raw)
            if not text:
                return None
            key = ru_key(text)
            name = self.ru_alias.get(key)
            if not name:
                filtered = ' '.join(x for x in key.split() if x not in RU_NOISE)
                name = self.ru_alias.get(filtered)
            if name:
                return ('known:' + name, name, True)
            return ('ru:' + key, text, True) if key else None
        # Try the unmodified NER term as well as the cleaned ingredient line.
        direct = self.en_alias.get(en_key(raw))
        text = en_name(raw)
        name = direct or self.en_alias.get(en_base(raw)) or self.en_alias.get(text)
        if name:
            return ('known:' + name, name, True)
        return ('en:' + text, text or clean(raw), False) if re.search('[a-z]', text) else None

    def groups(self, ingredients, language, ner=None):
        groups = []
        pending_alternative = False
        previous_was_alternative = False
        section_optional = False
        for index, raw in enumerate(ingredients):
            raw = str(raw).strip()
            if not raw or not re.search('[a-zа-яё]', raw, re.I):
                continue
            if clean(raw) in ('или', 'or'):
                # The source also emits stray standalone "или" after an
                # already-prefixed alternative. It must not absorb the next food.
                if not previous_was_alternative:
                    pending_alternative = True
                continue
            if language == 'ru' and (raw.endswith(':') or clean(raw).startswith('для ')):
                section_optional = bool(re.search('по желанию|для украшения|для подачи', clean(raw)))
                pending_alternative = False
                previous_was_alternative = False
                continue
            leading_alternative = bool(re.match(r'^(?:или|or)\s+', clean(raw)))
            if leading_alternative:
                raw = re.sub(r'^(?:или|or)\s+', '', raw, flags=re.I)
            optional = section_optional or bool(re.search(r'по желанию|необязательно|для украшения|для подачи|\boptional\b|\bfor garnish\b|\bfor serving\b', clean(raw)))
            comma_parts = [x.strip() for x in raw.split(',')]
            if language == 'en' and len(comma_parts) > 1 and not pending_alternative and not leading_alternative:
                values = [self.resolve(x, language) for x in comma_parts]
                if all(x and x[0].startswith('known:') for x in values):
                    for value in values:
                        groups.append({'index': index, 'options': [value], 'optional': optional})
                    previous_was_alternative = False
                    continue
            # Parse explicit alternatives as OR, combined ingredients as AND.
            namepart = ru_name(raw) if language == 'ru' else en_base(raw)
            # Combined comma lists are split only when they contain no quantities.
            combined = re.split(r'\s+(?:и|and|&)\s+|\s*,\s*(?=[а-яa-z])', namepart) if not re.search(r'\d', namepart) else [namepart]
            combined_resolved = [self.resolve(x, language) for x in combined]
            # Splitting an unknown phrase may manufacture an incomplete recipe.
            if not pending_alternative and not leading_alternative and len(combined) > 1 and all(x and x[0].startswith('known:') for x in combined_resolved):
                for part in combined:
                    groups.append({'index': index, 'options': [self.resolve(part, language)], 'optional': optional})
                previous_was_alternative = False
                continue
            alternatives = re.split(r'\s+(?:или|or)\s+', namepart)
            resolved = [self.resolve(x, language) for x in alternatives]
            resolved = [x for x in resolved if x]
            if resolved:
                if (pending_alternative or leading_alternative) and groups:
                    groups[-1]['options'] = list(dict.fromkeys(groups[-1]['options'] + resolved))
                else:
                    groups.append({'index': index, 'options': list(dict.fromkeys(resolved)), 'optional': optional})
            elif raw:
                # Unparseable ingredient remains a requirement, never vanishes.
                groups.append({'index': index, 'options': [('unparsed:' + language + ':' + clean(raw), raw, language == 'ru')], 'optional': optional})
            previous_was_alternative = bool(pending_alternative or leading_alternative or len(alternatives) > 1)
            pending_alternative = False
        return groups
