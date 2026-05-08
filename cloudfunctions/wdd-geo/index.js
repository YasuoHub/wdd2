const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error('解析响应失败'))
        }
      })
    }).on('error', reject)
  })
}

exports.main = async (event) => {
  const { action } = event

  if (action !== 'reverseGeocode') {
    return { code: -1, message: '未知 action' }
  }

  const { longitude, latitude } = event
  if (typeof longitude !== 'number' || typeof latitude !== 'number') {
    return { code: -1, message: '缺少经纬度参数' }
  }

  const QQ_MAP_KEY = process.env.QQ_MAP_KEY
  if (!QQ_MAP_KEY) {
    return { code: -1, message: '地图服务未配置' }
  }

  const url = `https://apis.map.qq.com/ws/geocoder/v1/?location=${latitude},${longitude}&key=${QQ_MAP_KEY}&get_poi=0`

  try {
    const data = await httpsGet(url)
    if (data.status === 0 && data.result) {
      const result = data.result
      const addressName = result.formatted_addresses?.recommend
        || result.formatted_addresses?.standard_address
        || result.address
        || '未知位置'
      return { code: 0, data: { address: addressName, fullResult: result } }
    }
    return { code: -1, message: data.message || '逆编码失败' }
  } catch (err) {
    return { code: -1, message: err.message || '逆编码请求失败' }
  }
}
