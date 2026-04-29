# 智回复移动端

React Native / Expo 手机端，用于连接正在运行的桌面端本地控制服务。

## 启动

```bash
cd mobile
npm install
npm start
```

## 配对流程

1. 启动桌面端应用。
2. 打开桌面端「设置」里的「手机连接」，确认本地服务端口并生成配对码。
3. 手机和 Mac 连接同一 Wi-Fi。
4. 在手机 App「连接」页填写 `http://<本机局域网IP>:<端口>`。
5. 输入桌面端生成的 6 位配对码，完成配对。

后续如果需要公网访问，可以把桌面端端口映射出去；手机端只需要把服务地址改成公网地址。

## 本地构建 Android 测试 APK

第一次构建前，Mac 需要安装 JDK 和 Android SDK，并设置好：

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

生成 Android 原生工程：

```bash
npm run prebuild:android
```

构建 debug APK：

```bash
npm run apk:debug
```

APK 输出位置：

```text
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

连接安卓手机并开启 USB 调试后，可以直接安装：

```bash
npm run android:install
```

## APK 真机测试

1. 启动桌面端应用，确认手机控制服务端口。
2. 在桌面端「设置」生成手机配对码。
3. 把 `app-debug.apk` 安装到安卓手机。
4. 打开「智回复APP」，进入「连接」页。
5. 服务地址填写 `http://<Mac局域网IP>:47831`。
6. 输入 6 位配对码，完成配对。
7. 回到首页验证开始、暂停、单次识别和日志同步。

debug APK 只用于测试安装；正式分发需要单独配置 release keystore。
