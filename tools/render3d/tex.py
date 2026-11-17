import sys, math
from PIL import Image, ImageDraw, ImageFilter
B, T = sys.argv[1], sys.argv[2]
for src, name in [('record_upload/04-result.png','screen_note'),('record_upload/01-ready.png','screen_ready'),('record_upload/02-rec.png','screen_rec')]:
    im = Image.open(f'{B}/{src}').convert('L').resize((200,200), Image.NEAREST)
    im = im.point(lambda v: 255 if v > 128 else 0)
    im = im.resize((1600,1600), Image.NEAREST).filter(ImageFilter.GaussianBlur(1.6))
    im.save(f'{T}/{name}.png')
def gear(path):
    S=512; im=Image.new('L',(S,S),255); d=ImageDraw.Draw(im); c=S/2
    pts=[]; n=8
    for i in range(n*4):
        a=2*math.pi*i/(n*4); r= 150 if (i%4) in (0,1) else 112
        a+= math.pi/(n*4)*0.5
        pts.append((c+r*math.cos(a), c+r*math.sin(a)))
    d.polygon(pts, fill=0); d.ellipse([c-58,c-58,c+58,c+58], fill=255)
    im.filter(ImageFilter.GaussianBlur(3)).save(path)
def power(path):
    S=512; im=Image.new('L',(S,S),255); d=ImageDraw.Draw(im); c=S/2
    d.arc([c-140,c-130,c+140,c+150], start=-50, end=230, fill=0, width=34)
    d.rounded_rectangle([c-17,c-170,c+17,c+10], radius=17, fill=0)
    im.filter(ImageFilter.GaussianBlur(3)).save(path)
def sdcard(path):
    W,H=470,390; im=Image.new('L',(W,H),0); d=ImageDraw.Draw(im)
    d.polygon([(8,8),(W-8,8),(W-8,H-8),(150,H-8),(150,H-50),(70,H-50),(70,H-8),(8,H-8)], fill=255)
    im.filter(ImageFilter.GaussianBlur(4)).save(path)
gear(f'{T}/icon_gear.png'); power(f'{T}/icon_power.png'); sdcard(f'{T}/icon_sd.png')
