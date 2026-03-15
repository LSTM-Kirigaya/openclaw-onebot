import { markdownToImage } from "../src/og-image.js";

// 生成更长的测试文本
const paragraphs = [];
for (let i = 0; i < 10; i++) {
  paragraphs.push(`这是第 ${i + 1} 段测试文字。人工智能（Artificial Intelligence，简称 AI）是指由人制造出来的系统所表现出来的智能。通常人工智能是指通过普通计算机程序来呈现人类智能的技术。该词也指出研究这样的智能系统是否能够实现，以及如何实现。`);
}

const md = `# 超长文本测试

${paragraphs.join("\n\n")}

## 结论

通过以上测试，我们可以验证图片生成是否能够正确处理超长文本内容。`;

async function main() {
  console.log("文本长度:", md.length, "字符");
  console.log("生成图片...");
  const result = await markdownToImage(md, { theme: "default" });
  
  if (result) {
    const { copyFileSync } = await import("fs");
    const path = result.replace("file://", "");
    copyFileSync(path, "./test/output-very-long.png");
    console.log("图片已保存到: ./test/output-very-long.png");
  }
}

main();
