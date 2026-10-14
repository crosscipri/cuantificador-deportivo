import copy
import unittest

from reviews.catalog import CatalogFilters, catalog_item, catalog_page, parse_catalog_filters


def publication(slug, score, price=None, brand='Marca A', currency='EUR'):
    link={'id':'amazon','url':'https://www.amazon.es/dp/SYNTHETIC','price':price,'currency':currency,'price_checked_at':'2026-10-05'}
    return {'version':'test', 'published_at':'2026-10-05T10:00:00Z',
            'article':{'slug':slug,'title':slug,'summary':'Prueba sintética','author':'Test',
                       'cover':{'media_id':'cover'},'categories':['Relojes'],'tags':[],
                       'blocks':[{'type':'verdict','scores':{'fc':score}},
                                 {'type':'purchase','links':[link],'affiliate_notice':'Enlace de prueba.'}]},
            'device':{'name':slug,'brand':brand,'model':slug,'purchase_links':[link]},
            'media':{'cover':{},'unused':{}},'evidence':{'PRIVATE':{}},'draft':{'PRIVATE':True}}


class CatalogTests(unittest.TestCase):
    def test_projection_is_immutable_and_partial_scores_keep_zero(self):
        p=publication('cero',0);before=copy.deepcopy(p);item=catalog_item(p)
        self.assertEqual(item['rating'],{'total':0,'areas':1,'fc':0,'hrv':None,'rest_hr':None,'gps':None})
        self.assertNotIn('blocks',item['article']);self.assertNotIn('draft',item)
        self.assertNotIn('evidence',item);self.assertEqual(set(item['media']),{'cover'})
        self.assertEqual(p,before)
        p['article']['blocks'][0]['scores']={'fc':-10,'hrv':None,'rest_hr':90,'gps':80}
        self.assertEqual(catalog_item(p)['rating']['total'],53.3)

    def test_amazon_hostname_and_currency(self):
        p=publication('producto',199)
        for url in ['https://amazon.es.evil.test/product','https://evil.test/amazon.es','https://user:password@amazon.es/product','javascript:alert(1)']:
            p['device']['purchase_links'][0]['url']=url
            self.assertIsNone(catalog_item(p)['amazon'])
        p['device']['purchase_links']=[{'id':'usd','url':'https://amazon.com/dp/test','price':10,'currency':'USD'},
                                     {'id':'eur','url':'https://www.amazon.es/dp/test','price':100,'currency':'EUR'},
                                     {'id':'eur2','url':'https://amzn.eu/test','price':90,'currency':'EUR'}]
        p['article']['blocks'][1]['links']=p['device']['purchase_links']
        self.assertEqual(catalog_item(p)['amazon']['price'],90)
        no_price=publication('sin-precio',90)
        self.assertIsNone(catalog_item(no_price)['amazon']['price'])

    def test_filters_apply_before_pagination_and_missing_scores_sort_last(self):
        items=[catalog_item(publication('Bíceps '+str(i),score,price,brand)) for i,score,price,brand in
               [(1,90,200,'Marca A'),(2,None,None,'Marca A'),(3,0,100,'Marca B'),(4,98,300,'Marca A')]]
        result=catalog_page(items,CatalogFilters(q='biceps',brand=['Marca A'],sort='score_desc',limit=1,page=2))
        self.assertEqual(result['total'],3);self.assertEqual(result['items'][0]['rating']['total'],90)
        self.assertTrue(result['has_more']);self.assertEqual(result['total_unfiltered'],4)
        ascending=catalog_page(items,CatalogFilters(sort='score_asc'))
        self.assertEqual([p['rating']['total'] for p in ascending['items']],[0,90,98,None])
        self.assertEqual(catalog_page(items,CatalogFilters(min_score=95))['total'],1)
        self.assertEqual(catalog_page(items,CatalogFilters(min_score=95,metric='gps'))['total'],0)
        self.assertEqual(catalog_page(items,CatalogFilters(complete_only=True))['total'],0)

    def test_price_filter_does_not_treat_missing_as_free_or_convert_currencies(self):
        items=[catalog_item(publication('sin',70)),catalog_item(publication('dolar',80,50,currency='USD')),
               catalog_item(publication('euro',90,100)),catalog_item(publication('gratis',60,0))]
        result=catalog_page(items,CatalogFilters(max_price=100,sort='price_asc'))
        self.assertEqual([p['article']['slug'] for p in result['items']],['gratis','euro'])
        self.assertEqual(catalog_page(items,CatalogFilters(q='inexistente'))['total'],0)
        parsed=parse_catalog_filters([('brand','Marca A'),('brand','Marca B'),('amazon_only','false'),('min_score','0')])
        self.assertEqual(parsed.brand,['Marca A','Marca B']);self.assertFalse(parsed.amazon_only)
        self.assertEqual(parsed.min_score,0)

    def test_offers_require_selected_frozen_purchase_blocks(self):
        p=publication('seleccion',90,199)
        p['device']['purchase_links'].append({'id':'unselected','label':'PRIVADO','url':'https://private.example.test/modelo','price':1,'currency':'EUR'})
        # The profile can contain a link that an editor has not included in the
        # article. Neither the offer nor its price should influence this page.
        p['article']['blocks'][1]['links']=p['article']['blocks'][1]['links'][:1]
        before=copy.deepcopy(p)
        item=catalog_item(p)
        self.assertEqual(len(item['offers']),1)
        self.assertEqual(item['best_offer']['price'],199)
        self.assertEqual(item['offers'][0]['notice'],'Enlace de prueba.')
        self.assertNotIn('PRIVADO',str(item))
        self.assertEqual(p,before)
        p['article']['blocks']=p['article']['blocks'][:1]
        self.assertEqual(catalog_item(p)['offers'],[])
        self.assertIsNone(catalog_item(p)['best_offer'])

    def test_offer_urls_reject_invalid_schemes_credentials_and_ambiguous_authorities(self):
        p=publication('seguridad',90)
        invalid=['javascript:alert(1)','data:text/html,hello','//shop.example.test/product',
                 'https:///product','https://user:secret@shop.example.test/product',
                 'https://shop.example.test:wrong/product','https://shop.example.test:99999/product',
                 'https://shop.example.test/a b','https://shop.example.test/a\nb',
                 'https://shop.example.test\\@amazon.es/product','https://[broken/product']
        for url in invalid:
            with self.subTest(url=url):
                p['device']['purchase_links'][0]['url']=url
                self.assertEqual(catalog_item(p)['offers'],[])
        for url in ['https://amazon.es.evil.test/product','https://evil.test/amazon.es']:
            p['device']['purchase_links'][0]['url']=url
            item=catalog_item(p)
            self.assertIsNone(item['amazon'])
            self.assertEqual(len(item['offers']),1)
            self.assertFalse(item['offers'][0]['is_amazon'])
        exact='https://WWW.AMAZON.ES:443/dp/SYNTHETIC?tag=synthetic-test-21&option=a%20b#color'
        p['device']['purchase_links'][0]['url']=exact
        self.assertEqual(catalog_item(p)['amazon']['url'],exact)
        self.assertEqual(catalog_item(p)['amazon']['shop'],'amazon')

    def test_store_prices_sort_filter_in_eur_and_amazon_filter_uses_amazon_price(self):
        def priced(slug,links):
            p=publication(slug,90)
            p['device']['purchase_links']=links
            p['article']['blocks'][1]['links']=links
            return catalog_item(p)
        def link(ident,host,price,currency='EUR'):
            return {'id':ident,'label':host,'url':'https://'+host+'/product','price':price,'currency':currency}
        a=priced('a',[link('amazon','amazon.es',300),link('official','shop.example.test',200)])
        b=priced('b',[link('amazon','amazon.es',250),link('official','shop.example.test',None)])
        c=priced('c',[link('official','shop.example.test',0)])
        d=priced('d',[link('dollar','other.example.test',1,'USD')])
        e=priced('e',[link('official','shop.example.test',None)])
        items=[d,b,e,a,c]
        self.assertEqual(a['amazon']['price'],300)
        self.assertEqual(a['best_offer']['price'],200)
        ascending=catalog_page(items,CatalogFilters(sort='price_asc'))
        self.assertEqual([p['article']['slug'] for p in ascending['items']],['c','a','b','d','e'])
        descending=catalog_page(items,CatalogFilters(sort='price_desc'))
        self.assertEqual([p['article']['slug'] for p in descending['items']],['b','a','c','d','e'])
        self.assertEqual([p['article']['slug'] for p in catalog_page(items,CatalogFilters(max_price=225,sort='price_asc'))['items']],['c','a'])
        amazon=catalog_page(items,CatalogFilters(amazon_only=True,max_price=275,sort='price_asc'))
        self.assertEqual([p['article']['slug'] for p in amazon['items']],['b'])
        self.assertEqual(amazon['items'][0]['matched_offer']['price'],250)
        shop=catalog_page(items,CatalogFilters(shop=['shop.example.test'],max_price=275,sort='price_asc'))
        self.assertEqual([p['article']['slug'] for p in shop['items']],['c','a'])
        self.assertEqual(shop['items'][1]['matched_offer']['price'],200)
        self.assertEqual(shop['items'][1]['matched_offer']['shop'],'shop.example.test')
        self.assertNotIn('matched_offer',a)  # A filtered page cannot mutate a reusable catalog entry.
        self.assertEqual(catalog_page(items,CatalogFilters(shop=['shop.example.test'],amazon_only=True,max_price=1000))['total'],0)
        self.assertEqual(catalog_page(items,CatalogFilters(shop=['shop.example.test'],amazon_only=True))['total'],0)

    def test_repeated_format_and_shop_filters_apply_before_pagination(self):
        items=[]
        for slug,fmt,host,price in [('a','Reloj','one.example.test',300),('b','Anillo','one.example.test',200),
                                   ('c','Brazalete','two.example.test',100),('d','Reloj','two.example.test',150)]:
            p=publication(slug,90)
            p['device']['format']=fmt
            links=[{'id':'shop','label':'Tienda','url':'https://'+host+'/model','price':price,'currency':'EUR'},
                   {'id':'same-shop','label':'Otra variante','url':'https://'+host+'/other','price':price+10,'currency':'EUR'}]
            p['device']['purchase_links']=links;p['article']['blocks'][1]['links']=links
            items.append(catalog_item(p))
        filters=parse_catalog_filters([('format','reloj'),('format','anillo'),('format','reloj'),
                                       ('shop','ONE.EXAMPLE.TEST'),('shop','two.example.test'),('page','2'),('limit','1'),('sort','price_asc')])
        self.assertEqual(filters.format,['reloj','anillo'])
        self.assertEqual(filters.shop,['ONE.EXAMPLE.TEST','two.example.test'])
        result=catalog_page(items,filters)
        self.assertEqual(result['total'],3)
        self.assertEqual(result['total_unfiltered'],4)
        self.assertEqual(result['items'][0]['article']['slug'],'b')
        self.assertTrue(result['has_more'])
        self.assertEqual(result['facets']['shops'],[{'value':'one.example.test','count':2},{'value':'two.example.test','count':2}])
        self.assertEqual(result['facets']['offers_count'],4)
        self.assertEqual(result['facets']['amazon_count'],0)
        self.assertEqual(catalog_page(items,CatalogFilters(offers_only=True))['total'],4)
        self.assertEqual(catalog_page(items,CatalogFilters(format=['inexistente']))['total'],0)

    def test_offer_price_zero_missing_invalid_and_foreign_currencies_are_distinct(self):
        p=publication('precios',90)
        links=[{'id':str(i),'label':'Tienda','url':'https://shop.example.test/'+str(i),'price':value,'currency':currency}
               for i,(value,currency) in enumerate([(None,'EUR'),(0,'EUR'),(-1,'EUR'),(float('nan'),'EUR'),
                                                    (True,'EUR'),(10,'USD'),(5,'GBP'),(9,'CHF')])]
        p['device']['purchase_links']=links;p['article']['blocks'][1]['links']=links
        item=catalog_item(p)
        self.assertEqual(item['best_offer']['price'],0)
        self.assertEqual(sum(o['price'] is None for o in item['offers']),4)
        self.assertEqual(catalog_page([item],CatalogFilters(max_price=0))['total'],1)
        # Without the zero-price EUR offer, a foreign currency amount cannot
        # become an implicitly converted EUR price, nor is an absent price free.
        p['device']['purchase_links']=[link for link in links if link['id']!='1']
        item=catalog_item(p)
        self.assertEqual(catalog_page([item],CatalogFilters(max_price=1000000))['total'],0)
        self.assertEqual(catalog_page([item],CatalogFilters(offers_only=True))['total'],1)


if __name__=='__main__':unittest.main()
