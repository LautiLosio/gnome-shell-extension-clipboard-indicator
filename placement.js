// Stage coordinates are logical pixels, including on mixed-scale monitors.
export function placePopup(x,y,area,width=460,height=440,margin=12) {
    width=Math.max(1,Math.min(width,area.width-2*margin));
    height=Math.max(1,Math.min(height,area.height-2*margin));
    const below=area.y+area.height-margin-y;
    const above=y-area.y-margin;
    const flip=below<height && above>below;
    // BoxPointer applies final screen clamping and arrow adjustment after layout.
    return {x:Math.max(area.x+margin,Math.min(x,area.x+area.width-margin)),
        y:Math.max(area.y+margin,Math.min(y,area.y+area.height-margin)),width,
        height:Math.max(180,Math.min(height,Math.max(below,above))),above:flip};
}
