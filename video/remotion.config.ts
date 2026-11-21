import { Config } from "@remotion/cli/config";
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(92);
Config.setBrowserExecutable(process.env.CHROME ?? "/usr/bin/google-chrome");
Config.setChromeMode("chrome-for-testing");
