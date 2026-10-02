# -*- coding: utf-8 -*-
"""把装在 ~/.petpet/pets/ 下的宠物素材打成本目录的 <id>.petpack。

    python pack_petpack.py

petpack 就是个 zip，顶层一个 <id>/ 目录，里面 pet.json + 每个动作一张精灵表。
install.mjs 会把它解到 ~/.petpet/pets/<id>/，PetPet 的「导入宠物包」也认它。

**为什么不跟着仓库走**：whalegirl.petpack 打出来 115MB（invade 那张表一个人就 38MB），
超过 GitHub 单文件 100MB 的上限，推不上去；而且 zip 没法 delta 压缩，每重打一次就往
.git 里塞一整份。所以它在这里是个**构建产物**，不纳入版本管理（见 .gitignore）。
素材本身在绿色版的 pets/ 里是齐的，那才是推荐的安装路径。

**只收 pet.json 和 *_sheet.png。** 素材目录里还有 activity.json（这只宠物自己攒的日记：
谁在什么时候跟她说了什么），属于本地数据，不该跟着包发出去；*.bak 那些更不收 ——
`*_sheet.png` 这个后缀天然把它们排除掉。

**两只都要打**：whalegirl 是本体；naijing 是右键菜单那条入侵动画播完切过去的那只 ——
少了它，彩蛋演到最后会切到一只不存在的宠物。
"""
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.expanduser('~'), '.petpet', 'pets')
PET_IDS = ['whalegirl', 'naijing']


def pack(pet_id):
    src = os.path.join(SRC, pet_id)
    out = os.path.join(HERE, pet_id + '.petpack')
    tmp = out + '.new'

    names = ['pet.json']
    dirs = []
    for d in sorted(os.listdir(src)):
        p = os.path.join(src, d)
        if not os.path.isdir(p):
            continue
        sheets = sorted(f for f in os.listdir(p) if f.endswith('_sheet.png'))
        if not sheets:
            continue
        dirs.append(d)
        names += ['%s/%s' % (d, f) for f in sheets]

    # 目录条目也写：跟旧包的形状一致（zipfile 只写它被告知的东西，不会自动带上空目录）。
    # 排序靠的是字典序 —— 目录名带尾斜杠，'<id>/x/' 天然排在 '<id>/x/y' 前面。
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
        for d in sorted(dirs):
            z.writestr(zipfile.ZipInfo('%s/%s/' % (pet_id, d)), b'')
        for n in names:
            z.write(os.path.join(src, n.replace('/', os.sep)), '%s/%s' % (pet_id, n))

    print('源目录 %s' % src)
    print('  %d 个动作 + pet.json，共 %d 个文件' % (len(dirs), len(names)))
    print('  动作: %s' % ', '.join(dirs))
    with zipfile.ZipFile(tmp) as z:
        bad = [i.filename for i in z.infolist()
               if any(ord(c) > 127 for c in i.filename) and not (i.flag_bits & 0x800)]
        if bad:
            raise SystemExit('!! 非 ASCII 名字没带 UTF-8 标志：%s' % bad)
        # pet.json 必须在最外层包里且能解析 —— 解包后 PetPet 第一件事就是读它
        got = json.loads(z.read('%s/pet.json' % pet_id).decode('utf-8'))['id']
        if got != pet_id:
            raise SystemExit('!! pet.json 的 id 是 %r，不是 %r' % (got, pet_id))
    os.replace(tmp, out)
    print('  已写出 %s（%.1f MB）\n' % (out, os.path.getsize(out) / 1e6))


for pid in PET_IDS:
    if not os.path.isdir(os.path.join(SRC, pid)):
        sys.exit('缺宠物目录：%s（先用绿色版的 启动.cmd 装一遍素材）' % os.path.join(SRC, pid))
    pack(pid)
