"""Generate PWA icons (icons/*.png).
Draws a glowing pan-fried dumpling (potsticker). To use a real photo / AI-generated image instead,
put a square PNG at icons/source.png and run:  python3 tools/make_icons.py --from-source
"""
import sys, math, random
from PIL import Image, ImageDraw, ImageFilter, ImageChops
S=2048
def glow_bg(size):
    im=Image.new('RGB',(size,size),(34,20,13)); px=im.load(); c=size/2
    for y in range(size):
        for x in range(size):
            d=math.hypot(x-c,y-c*1.02)/(size*.62); t=max(0,1-d)**1.6
            px[x,y]=(int(34+t*210),int(20+t*120),int(13+t*40))
    return im
def dumpling():
    L=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(L)
    # body: crescent (two overlapping ellipses), golden crispy bottom
    d.ellipse((300,700,1748,1500),fill=(244,201,125,255))
    d.ellipse((300,980,1748,1560),fill=(214,148,62,255))          # fried bottom
    d.ellipse((380,1010,1668,1500),fill=(236,181,97,255))
    # top highlight
    hl=Image.new('RGBA',(S,S),(0,0,0,0)); ImageDraw.Draw(hl).ellipse((420,760,1500,1150),fill=(255,240,200,150))
    L=Image.alpha_composite(L,hl.filter(ImageFilter.GaussianBlur(60)))
    d=ImageDraw.Draw(L)
    # pleats along the top ridge
    for i in range(9):
        t=i/8; x=520+t*1000; y=790-math.sin(t*math.pi)*70+ (t*60)
        d.line((x,y,x+30,y+210),fill=(196,128,52,255),width=26)
    # crispy lattice of toasted spots
    random.seed(3)
    for _ in range(220):
        x=random.randint(420,1620); y=random.randint(1180,1480)
        if ((x-1024)/700)**2+((y-1240)/290)**2<1: d.ellipse((x,y,x+random.randint(8,22),y+random.randint(6,14)),fill=(168,98,36,150))
    # clip to dumpling alpha
    return L
def build():
    base=glow_bg(1024).resize((S,S),Image.BICUBIC)
    dm=dumpling()
    a=dm.split()[3]
    glow=Image.new('RGBA',(S,S),(255,190,90,0)); glow.putalpha(a.filter(ImageFilter.GaussianBlur(120)).point(lambda v:min(255,int(v*1.2))))
    base=Image.alpha_composite(base.convert('RGBA'),glow)
    sh=Image.new('RGBA',(S,S),(0,0,0,0)); sh.putalpha(a.filter(ImageFilter.GaussianBlur(50)).point(lambda v:int(v*.5)))
    base=Image.alpha_composite(base,ImageChops.offset(sh,0,40))
    base=Image.alpha_composite(base,dm)
    # sparkles
    sp=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(sp)
    for x,y,r in [(1560,640,70),(420,560,48),(1700,980,36),(300,1000,30)]:
        d.polygon([(x,y-r),(x+r*.22,y-r*.22),(x+r,y),(x+r*.22,y+r*.22),(x,y+r),(x-r*.22,y+r*.22),(x-r,y),(x-r*.22,y-r*.22)],fill=(255,248,225,255))
    base=Image.alpha_composite(base,sp.filter(ImageFilter.GaussianBlur(3)))
    return base.convert('RGB')
def main():
    if '--from-source' in sys.argv: full=Image.open('icons/source.png').convert('RGB').resize((S,S),Image.LANCZOS)
    else: full=build()
    out=lambda n,sz,img=None:(img or full).resize((sz,sz),Image.LANCZOS).save(f'icons/{n}.png',optimize=True)
    out('icon-512',512);out('icon-192',192);out('apple-touch-icon',180);out('favicon-32',32)
    # maskable: keep subject inside the central safe zone (80%)
    m=Image.new('RGB',(S,S),(34,20,13)); inner=full.resize((int(S*.8),)*2,Image.LANCZOS); m.paste(inner,(int(S*.1),)*2)
    out('icon-maskable-512',512,m)
main()
