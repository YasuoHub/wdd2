# 本地图标字体

小程序中的 `wdd-icon` 使用本地 Lucide Iconfont，不依赖网络字体。

- `wdd-lucide.woff`：小程序内嵌使用的字体子集，兼容范围更广。
- `wdd-lucide.woff2`：同一字体子集的 WOFF2 备份版本。
- `svg/`：生成字体所使用的原始 Lucide SVG，仅作为维护源文件。
- 小程序运行时字体以 Base64 形式内嵌在 `components/icon/icon.wxss` 中。
- 图标名称与编码映射位于 `components/icon/iconfont-map.js`。

图标遵循 `svg/LUCIDE-LICENSE.txt` 中的 ISC 许可证。
