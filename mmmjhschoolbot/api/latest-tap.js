/** Disabled ESP8266 poll target. Returns empty 204 so leftover clients do not 404-retry. */
module.exports = function latestTap(req, res) {
  res.statusCode = 204;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end();
};
