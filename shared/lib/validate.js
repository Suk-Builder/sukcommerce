/**
 * 参数验证工具
 */
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
  return /^1[3-9]\d{9}$/.test(phone);
}

function validateRequired(obj, fields) {
  const missing = [];
  for (const field of fields) {
    if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
      missing.push(field);
    }
  }
  return missing;
}

function sanitizeString(str, maxLength = 255) {
  if (!str || typeof str !== 'string') return '';
  return str.trim().slice(0, maxLength);
}

module.exports = { validateEmail, validatePhone, validateRequired, sanitizeString };
