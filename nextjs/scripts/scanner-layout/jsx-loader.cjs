const { transform } = require(process.cwd() + '/node_modules/sucrase')
module.exports = function(source) { return transform(source, { transforms: ['jsx'], jsxRuntime: 'automatic', production: true, filePath: this.resourcePath }).code }
