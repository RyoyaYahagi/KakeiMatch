# Legacy記録

このディレクトリは、Issue #39の開始時点までに記録されたサーバー中心構成の設計・計画を履歴として保存します。ここにあるphase status、起動手順、環境要件は現在の本番構成ではありません。

- [Architecture](ARCHITECTURE.md): Issue #39開始前のアーキテクチャ記録
- [Implementation Plan](IMPLEMENTATION_PLAN.md): 旧Next.js構成を含む実装計画
- [Legacy runtime inventory](../LEGACY_RUNTIME_INVENTORY.md): 旧runtimeの分類と隔離先
- [Current architecture](../ARCHITECTURE.md): 現行PWA・Cloudflare構成

legacy sourceは旧テストや移行参照のため、すべてをこのdirectoryへ移動したわけではありません。現行productionから参照できるbrowser-safe root modulesは、[PWA build configuration](../../apps/pwa/vite.config.ts)で9ファイルに限定し、bundlerのmodule graph全体を検査します。legacy sourceをproduction bundleへ混入させないでください。
