import html,html.parser
def caption(row):
 for field in ('case_name','case_name_full','case_name_short'):
  value=(row.get(field) or '').strip()
  if value and value not in ('\\N','N','null','None'):return value
 return ''
class Text(html.parser.HTMLParser):
 def __init__(self):super().__init__(convert_charrefs=True);self.parts=[];self.skip=0
 def handle_starttag(self,tag,attrs):
  if tag in ('script','style'):self.skip+=1
  if tag in ('p','div','br','li','tr','h1','h2','table','section','blockquote','pre'):self.parts.append('\n')
 def handle_endtag(self,tag):
  if tag in ('script','style'):self.skip=max(0,self.skip-1)
  if tag in ('p','div','li','tr','h1','h2','table','section','blockquote','pre'):self.parts.append('\n')
 def handle_data(self,data):
  if not self.skip:self.parts.append(data)
def body(row):
 for field in ['plain_text','html_with_citations','html','html_lawbox','html_columbia','html_anon_2020','xml_harvard','xml_scan']:
  value=row.get(field)
  if value and value!='\\N' and value.strip():
   if field=='plain_text':return value,field
   parser=Text()
   try:parser.feed(value);text=''.join(parser.parts)
   except Exception:
    import re
    text=html.unescape(re.sub(r'<[^>]+>',' ',value))
   if text.strip():return text,field
 return None,None
