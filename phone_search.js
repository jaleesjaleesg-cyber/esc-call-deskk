(function attachPhoneSearch(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ESCPhoneSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildPhoneSearch() {
  'use strict';

  function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function normalizeUkPhone(value) {
    let digits = digitsOnly(value);
    // UK phone numbers: handle +44, 0044, 44 prefixes and optional (0)
    if (digits.startsWith('00440')) digits = `0${digits.slice(5)}`;
    else if (digits.startsWith('0044')) digits = `0${digits.slice(4)}`;
    else if (digits.startsWith('440') && digits.length >= 12) digits = `0${digits.slice(3)}`;
    else if (digits.startsWith('44') && digits.length >= 11) digits = `0${digits.slice(2)}`;
    return digits;
  }

  function isUkMobile(value) {
    const normalized = normalizeUkPhone(value);
    // Standard UK mobile numbers start with 07 and are 11 digits long
    return normalized.startsWith('07') && normalized.length === 11;
  }

  function extractPhoneEntries(company) {
    const entries = [];
    const seen = new Set();

    function addEntry(phone, meta = {}) {
      const text = String(phone || '').trim();
      if (!text) return;
      const normalized = normalizeUkPhone(text);
      if (!normalized || seen.has(text)) return;
      seen.add(text);

      const mobile = isUkMobile(text) || meta.type === 'mobile' || /mobile|cell/i.test(meta.purpose || '');
      entries.push({
        number: text,
        normalized,
        isMobile: Boolean(mobile),
        purpose: meta.purpose || (mobile ? 'Mobile' : 'Phone'),
        dmName: meta.dmName || '',
        dmRole: meta.dmRole || ''
      });
    }

    if (!company || typeof company !== 'object') return entries;

    // Direct company phone
    if (company.phone) addEntry(company.phone, { purpose: 'Main Office' });
    if (company.last_phone_used && company.last_phone_used !== company.phone) {
      addEntry(company.last_phone_used, { purpose: 'Last Called' });
    }

    // Phone numbers list (strings or structured objects)
    for (const item of company.phone_numbers || []) {
      if (typeof item === 'string') {
        addEntry(item);
      } else if (item && typeof item === 'object') {
        const num = item.number || item.phone || item.mobile || item.raw || item.formatted;
        addEntry(num, {
          purpose: item.purpose || '',
          type: item.type || '',
          dmName: item.dm_name || item.dmName || ''
        });
      }
    }

    // Decision makers
    for (const person of company.decision_makers || []) {
      if (!person || typeof person !== 'object') continue;
      const candidatePhones = [
        { num: person.phone, purpose: 'Direct Line' },
        { num: person.mobile, purpose: 'Direct Mobile' },
        { num: person.mobile_number, purpose: 'Direct Mobile' },
        { num: person.direct_phone, purpose: 'Direct Line' },
        { num: person.telephone, purpose: 'Office Phone' },
        { num: person.contact_number, purpose: 'Contact Number' }
      ];
      for (const p of candidatePhones) {
        if (p.num) {
          addEntry(p.num, {
            dmName: person.name || '',
            dmRole: person.role || 'Decision Maker',
            purpose: isUkMobile(p.num) ? 'Direct Mobile' : p.purpose
          });
        }
      }
    }

    // Statutory directors
    for (const director of company.statutory_directors || []) {
      if (!director || typeof director !== 'object') continue;
      const dirPhones = [director.phone, director.mobile, director.direct_phone];
      for (const dPhone of dirPhones) {
        if (dPhone) {
          addEntry(dPhone, {
            dmName: director.name || '',
            dmRole: director.role || 'Director',
            purpose: isUkMobile(dPhone) ? 'Director Mobile' : 'Director Phone'
          });
        }
      }
    }

    return entries;
  }

  function companyPhoneValues(company) {
    return extractPhoneEntries(company).map(entry => entry.number);
  }

  function matchingPhoneDetails(company, query) {
    const rawQuery = String(query || '').trim().toLowerCase();
    if (!rawQuery) return null;
    const normalizedQuery = normalizeUkPhone(rawQuery);
    const numericSearch = normalizedQuery.length >= 4;

    const entries = extractPhoneEntries(company);

    // 1. Check exact / partial normalized match
    for (const entry of entries) {
      if (entry.number.toLowerCase().includes(rawQuery)) {
        return entry;
      }
      if (numericSearch && entry.normalized.includes(normalizedQuery)) {
        return entry;
      }
      // If query omitted leading zero for mobile (e.g. 7700900123 vs 07700900123)
      if (numericSearch && entry.normalized.startsWith('0') && entry.normalized.slice(1).includes(normalizedQuery)) {
        return entry;
      }
    }
    return null;
  }

  function matchingPhone(company, query) {
    const details = matchingPhoneDetails(company, query);
    return details ? details.number : '';
  }

  function companyMatchesPhone(company, query) {
    return Boolean(matchingPhone(company, query));
  }

  function searchCompaniesByPhone(database, query, limit = 25) {
    const rawQuery = String(query || '').trim();
    if (!rawQuery || !database) return [];
    const results = [];

    const companies = Array.isArray(database) ? database : Object.values(database);
    for (const company of companies) {
      const match = matchingPhoneDetails(company, rawQuery);
      if (match) {
        results.push({ company, match });
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  return {
    digitsOnly,
    normalizeUkPhone,
    isUkMobile,
    extractPhoneEntries,
    companyPhoneValues,
    matchingPhoneDetails,
    matchingPhone,
    companyMatchesPhone,
    searchCompaniesByPhone
  };
});
