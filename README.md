# dsh-sort-out-the-thoughts · 梳理思路

[![npm](https://img.shields.io/npm/v/dsh-sort-out-the-thoughts)](https://www.npmjs.com/package/dsh-sort-out-the-thoughts)
[![月下载](https://img.shields.io/npm/dm/dsh-sort-out-the-thoughts)](https://www.npmjs.com/package/dsh-sort-out-the-thoughts)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-blue)](https://github.com/hulibuld/dsh-sort-out-the-thoughts)
[![License](https://img.shields.io/npm/l/dsh-sort-out-the-thoughts)](LICENSE)

`dsh plugin --profile desktop add dsh-sort-out-the-thoughts` · [遇到问题开 issue](https://github.com/hulibuld/dsh-sort-out-the-thoughts/issues/new/choose)

把一句模糊的念头，聊成一个真能写出来、真能讲出来的东西。

输入框左边有个「梳理」开关。打开它，AI 换一副面孔：不急着替你写，先问你——这东西到底想说什么，凭什么成立，谁会不同意，缺哪块材料。

## 装

在 DSH 会话里让智能体装：

```
plugin_manager action=install_bundle target=<目录绝对路径>
```

装完不用重启，先看 `application: applied`。然后对话框左边出现开关，右下角出现随想球。

## 三段

打开开关之后不是随便聊，走三段。

先梳理，把你自己的观点和我们聊出来的观点分开列清。再批判，指出方案和认知里的缺陷。最后调研，把问题抽象成能检索的命题，跨领域查证，再落回你的需求。

每段的结论单独存在这条思路里，换段不会覆盖上一段。想法往前推进时会顺手记下主旨、结构和还没解决的问题。关掉开关，这一条归档进设置里的 Thoughts Center，按体裁分组，能搜，能回看。

每段快收尾时它会停下来让你二选一：留在本段继续挖，还是进下一段。同一段只问一次。你也可以随时说「进下一段」。

聊够了不用等它问。输入框旁边会多一个「推进到第 N 段」按钮，你觉得这一段的活干完了就点。点之前它会先过一遍这一段该留下的东西，缺了就告诉你缺哪几项，再点一次仍然可以硬推。每段都有该留下的产物清单，机器判有或没有，判得好不好仍然是你的事。

给写文章、写演讲稿、写自媒体文稿的人用。

## 怎么用

1. 打开一个对话，点输入框左边的「梳理」。
2. 把脑子里那团东西随便说出来，越糙越好，不用组织语言。
3. 回答它的追问。问得烦就说「别问了，先给我个骨架」，它照办。
4. 想收尾说一句「差不多了，定稿」，这条就归档。
5. 去 设置 → Thoughts Center 找它，每条右边直接有删掉，点一下变确认，再点一下才真删。

## 随想

想法还碎的时候，别逼自己先起标题。

右下角那颗随想球，点一下当场变成本子，位置不跳。点本子右上角 ×，又变回球，球回到它原来待的地方。两个都能按住拖动，位置记在一处。拖到屏幕边上会自己弹回来，不会掉出去。

本子右上角四个小圆点是纸色：纸米黄、护眼绿、白纸、深灰。点一下换，记住你选的那一种。

写一句，点记下或者按 `⌘/Ctrl + Enter`。字压在横线上，不用管体裁，不用管顺序。

攒到某天想认真梳了，挑一条点「去研究」。它新开一条会话，把那句话按固定模板写进输入框，梳理开关也顺手替你打开。想限定方向就在末尾补一句再回车。用过的随想标「已开过」，但不会消失。

设置 → Thoughts Center → 随想 页签里也有全部记录，能看时间、能删。

嫌球碍眼：Thoughts Center 最上面有「悬浮笔记本」，点隐藏就没了，点显示再叫回来，不用重启也不用刷新。

随想和思路分开存。随想是原料，思路是成品。

## 数据在哪

```
<DSH_HOME>/plugin-data/dsh-sort-out-the-thoughts/
  thoughts.json   思路库
  mode.json       哪些会话开着梳理模式
  sparks.json     随想记录本
  prefs.json      偏好
```

`DSH_HOME` 默认是 `~/.dsh`。四个都是普通 JSON，随时能备份或搬走。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxThoughts` | `500` | 条目上限，写满先淘汰最老的已归档条目 |

## 边界

开关是会话级的，不跨会话继承。梳理模式会改变 AI 的说话方式，不该默默接管所有对话。

它负责把想法推成结构，不负责替你查证。事实、引语、数据还得自己核。

演化轨迹只记阶段、主旨、标题的快照，不存每个版本的全文。要保全文就导出 Markdown。

## 卸载

```
plugin_manager action=remove_bundle target=dsh-sort-out-the-thoughts
```

卸载不删思路库。想彻底清掉，删掉上面那个数据目录即可。

## 许可

MIT。三段推进里「每段有产物、换段有闸门、决定有留痕」这套做法参照了 lunheng-article-pipeline 的闸门思路。
